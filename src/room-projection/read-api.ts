import { z } from "zod";
import { DatabaseUnavailableError } from "../db/errors.js";
import { MCP_2026_PROTOCOL_VERSION } from "../config/external-mcp.js";
import {
  anvilSubjectLabel,
  ROOM_STATUSES,
  type AnvilRoomSubject,
  type ObservedRead,
  type ProjectedRoom,
} from "./contract.js";
import {
  RoomCapabilityDeniedError,
  RoomNotFoundError,
  type RoomAuthorityReader,
  type RoomEventPage,
  type RoomSnapshot,
} from "./reader.js";

/**
 * Neo-side Room read API transport (I2, DESIGN-I1-I7 §3/D2).
 *
 * Hub reaches Neo `anvil_core` authority through the `anvil-neo-mcp` tailnet
 * surface — never direct Postgres (Neo :5432 refuses tailnet-direct peers).
 * The surface is MCP Streamable HTTP `POST /mcp`, protocol `2026-07-28`,
 * stateless `JSONResponse`, bearer-authenticated; grant checks for the bound
 * subject are enforced Neo-side by the read service.
 *
 * Coordinated contract (cells/anvil-i17-i2hub/context/neo-read-api-contract.md):
 * each tool returns `structuredContent` — `{status:"ok", observed_at, …}` on
 * success or `{status:"room_not_found"|"capability_denied"}` for domain
 * outcomes. `observed_at` is the service's own stamp of when the authority
 * state was observed; Hub falls back to response-receipt time when absent.
 * Transport/protocol faults map to `DatabaseUnavailableError` →
 * `infrastructure_unavailable`; Hub never manufactures a domain answer.
 */
export const NEO_READ_API_TOOLS = {
  list: "anvil.room_list",
  snapshot: "anvil.room_snapshot",
  events: "anvil.room_events",
} as const;

export interface NeoReadApiOptions {
  /** MCP endpoint URL, e.g. `https://<neo-host>:8443/mcp` (or loopback http). */
  url: string;
  token: string;
  subject: AnvilRoomSubject;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Per-call timeout; default 5000ms mirrors the SQL transport's query cap. */
  timeoutMs?: number;
  /** Tool-name overrides for coordinated drift; defaults to NEO_READ_API_TOOLS. */
  tools?: Partial<Record<keyof typeof NEO_READ_API_TOOLS, string>>;
}

const WireRoomSchema = z.object({
  room_id: z.string(),
  project_ref: z.string().nullable(),
  status: z.enum(ROOM_STATUSES),
  correlation_id: z.string(),
  latest_seq: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
});

const WireParticipantSchema = z.object({
  participant_id: z.string(),
  agent_id: z.string(),
  role: z.string(),
  joined_seq: z.number().int().nullable(),
  acked_seq: z.number().int().nonnegative(),
  joined_at: z.string(),
});

const WireEventSchema = z.object({
  event_id: z.string(),
  room_id: z.string(),
  room_seq: z.number().int().positive(),
  kind: z.string(),
  producer: z.string(),
  payload: z.record(z.string(), z.unknown()),
  link: z.record(z.string(), z.unknown()),
  correlation_id: z.string(),
  causation_id: z.string().nullable(),
  task_ref: z.string().nullable(),
  campaign_id: z.string().nullable(),
  idempotency_key: z.string(),
  occurred_at: z.string().nullable(),
  created_at: z.string(),
});

const WireListSchema = z.object({
  status: z.literal("ok"),
  observed_at: z.string().optional(),
  rooms: z.array(WireRoomSchema),
});

const WireSnapshotSchema = z.object({
  status: z.literal("ok"),
  observed_at: z.string().optional(),
  room: WireRoomSchema,
  participants: z.array(WireParticipantSchema),
});

const WireEventsSchema = z.object({
  status: z.literal("ok"),
  observed_at: z.string().optional(),
  room: WireRoomSchema,
  events: z.array(WireEventSchema),
  latest_seq: z.number().int().nonnegative(),
});

const WireDomainStatusSchema = z.object({
  status: z.enum(["room_not_found", "capability_denied"]),
});

const McpTextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const McpResultSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  content: z.array(z.unknown()).optional(),
});

const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  result: McpResultSchema.optional(),
  error: z
    .object({ code: z.number(), message: z.string(), data: z.unknown().optional() })
    .optional(),
});

export function createNeoReadApiReader(options: NeoReadApiOptions): RoomAuthorityReader {
  const tools = { ...NEO_READ_API_TOOLS, ...options.tools };
  const subjectLabel = anvilSubjectLabel(options.subject);

  async function callTool(
    tool: string,
    args: Record<string, unknown>,
    roomPublicId?: string,
  ): Promise<Record<string, unknown>> {
    const structured = await postToolCall(options, tool, {
      subject: subjectLabel,
      ...args,
    });
    const domain = WireDomainStatusSchema.safeParse(structured);
    if (domain.success) {
      if (domain.data.status === "room_not_found") {
        throw new RoomNotFoundError(roomPublicId ?? "unknown");
      }
      throw new RoomCapabilityDeniedError("room.read", subjectLabel, roomPublicId ?? "unknown");
    }
    return structured;
  }

  /** A wire shape violation is a protocol fault, not a domain answer. */
  function parseWire<Schema extends z.ZodType>(
    schema: Schema,
    structured: Record<string, unknown>,
  ): z.infer<Schema> {
    const parsed = schema.safeParse(structured);
    if (!parsed.success) {
      throw new DatabaseUnavailableError("neo room read api returned malformed payload", {
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  return {
    async listReadableRooms(): Promise<ObservedRead<readonly ProjectedRoom[]>> {
      const structured = await callTool(tools.list, {});
      const wire = parseWire(WireListSchema, structured);
      return { value: wire.rooms, observed_at: readObservedAt(wire.observed_at) };
    },

    async readSnapshot(roomPublicId: string): Promise<ObservedRead<RoomSnapshot>> {
      const structured = await callTool(tools.snapshot, { room_id: roomPublicId }, roomPublicId);
      const wire = parseWire(WireSnapshotSchema, structured);
      return {
        value: { room: wire.room, participants: wire.participants },
        observed_at: readObservedAt(wire.observed_at),
      };
    },

    async replayEvents(
      roomPublicId: string,
      after: number,
      limit: number,
    ): Promise<ObservedRead<RoomEventPage>> {
      const structured = await callTool(
        tools.events,
        { room_id: roomPublicId, after, limit },
        roomPublicId,
      );
      const wire = parseWire(WireEventsSchema, structured);
      // Same idempotent-projection guard as the SQL reader: collapse any
      // re-delivered (room_id, room_seq) pair rather than trusting the wire.
      const seen = new Set<number>();
      const events = wire.events.filter((event) => {
        if (seen.has(event.room_seq)) return false;
        seen.add(event.room_seq);
        return true;
      });
      return {
        value: { room: wire.room, events, latestSeq: wire.latest_seq },
        observed_at: readObservedAt(wire.observed_at),
      };
    },
  };
}

/** The service's observation stamp when valid, else response receipt time. */
function readObservedAt(value: string | undefined): string {
  if (value !== undefined) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

async function postToolCall(
  options: NeoReadApiOptions,
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const fetchFn = options.fetchFn ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(options.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MCP_2026_PROTOCOL_VERSION,
        "mcp-method": "tools/call",
        "mcp-name": tool,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MCP_2026_PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientInfo": {
              name: "paseo-hub-room-projection",
              version: "0.9.0",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
          name: tool,
          arguments: args,
        },
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
  } catch (error) {
    throw new DatabaseUnavailableError("neo room read api unreachable", { cause: error });
  }
  if (!response.ok) {
    throw new DatabaseUnavailableError(`neo room read api answered HTTP ${response.status}`);
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    throw new DatabaseUnavailableError("neo room read api returned non-JSON", { cause: error });
  }
  const envelope = JsonRpcResponseSchema.safeParse(parsed);
  if (!envelope.success || envelope.data.error !== undefined) {
    throw new DatabaseUnavailableError("neo room read api protocol failure");
  }
  const result = envelope.data.result;
  if (result === undefined) {
    throw new DatabaseUnavailableError("neo room read api returned no result");
  }
  const structured = extractStructured(result);
  if (result.isError === true || structured === undefined) {
    throw new DatabaseUnavailableError("neo room read api tool call failed");
  }
  return structured;
}

/**
 * Prefer `structuredContent` (the go-sdk marshals handler outputs there); fall
 * back to a JSON-encoded text content block for servers that only fill
 * `content`.
 */
function extractStructured(
  result: z.infer<typeof McpResultSchema>,
): Record<string, unknown> | undefined {
  if (result.structuredContent !== undefined) return result.structuredContent;
  for (const item of result.content ?? []) {
    const text = McpTextContentSchema.safeParse(item);
    if (text.success) {
      try {
        const record = z.record(z.string(), z.unknown()).safeParse(JSON.parse(text.data.text));
        if (record.success) return record.data;
      } catch {
        // not JSON content — keep scanning
      }
    }
  }
  return undefined;
}
