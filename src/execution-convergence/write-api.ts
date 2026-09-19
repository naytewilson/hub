import { z } from "zod";
import { DatabaseUnavailableError } from "../db/errors.js";
import { MCP_2026_PROTOCOL_VERSION } from "../config/external-mcp.js";
import {
  anvilSubjectLabel,
  ROOM_STATUSES,
  type AnvilRoomSubject,
} from "../room-projection/contract.js";
import { RoomCapabilityDeniedError, RoomNotFoundError } from "../room-projection/reader.js";
import { EXECUTION_STATES, EXECUTION_SUBSTATES, RoomNotActiveError } from "./contract.js";
import type {
  CommittedTransition,
  ExecutionAuthorityGateway,
  ResolvedExecutionBinding,
} from "./gateway.js";

/**
 * Neo-side write API transport for the execution-convergence gateway (I3/I4,
 * DESIGN-I1-I7 §5.3). Same MCP Streamable-HTTP surface as the read path
 * (`anvil-neo-mcp`, `POST /mcp`, bearer auth) — but writes go through
 * authority-context service tools, never a bare participant append: the
 * authority-only `execution.transition` kind requires it (i1 ACK
 * 20260919-i1-write-api-ack).
 *
 * Coordinated contract (cells/anvil-i17-i1/inbox/20260919-i3-write-api-contract.md):
 * each tool returns `structuredContent` — `{status:"ok", …}` on success or a
 * domain outcome (`binding_not_found`, `room_not_found`, `room_not_active`,
 * `grant_not_found`, `capability_denied`, `not_participant`, `validation`).
 * Transport/protocol faults map to `DatabaseUnavailableError` →
 * `infrastructure_unavailable`; Hub never manufactures a domain answer.
 */
export const NEO_WRITE_API_TOOLS = {
  resolve: "anvil.execution_resolve",
  append: "anvil.room_event_append",
  eventFind: "anvil.room_event_find",
  grantMint: "anvil.grant_mint",
  grantGet: "anvil.grant_get",
} as const;

export interface NeoWriteApiOptions {
  /** MCP endpoint URL, e.g. `https://<neo-host>:8443/mcp` (or loopback http). */
  url: string;
  token: string;
  subject: AnvilRoomSubject;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Per-call timeout; default 5000ms mirrors the SQL transport's query cap. */
  timeoutMs?: number;
  /** Tool-name overrides for coordinated drift; defaults to NEO_WRITE_API_TOOLS. */
  tools?: Partial<Record<keyof typeof NEO_WRITE_API_TOOLS, string>>;
}

const WireLastTransitionSchema = z.object({
  state: z.enum(EXECUTION_STATES),
  substate: z.enum(EXECUTION_SUBSTATES).nullable(),
  room_seq: z.number().int().positive(),
  event_id: z.string(),
  occurred_at: z.string().nullable(),
  causation_id: z.string().nullable(),
});

const WireResolveSchema = z.object({
  status: z.literal("ok"),
  execution_id: z.string(),
  binding_id: z.string(),
  binding_status: z.enum(["active", "replaced", "released"]),
  room_id: z.string(),
  room_internal_id: z.number().int(),
  room_status: z.enum(ROOM_STATUSES),
  correlation_id: z.string(),
  last_transition: WireLastTransitionSchema.nullable(),
});

const WireAppendSchema = z.object({
  status: z.literal("ok"),
  event_id: z.string(),
  room_seq: z.number().int().positive(),
  duplicate: z.boolean(),
  to: z.string(),
  substate: z.string().nullable(),
  correlation_id: z.string(),
  causation_id: z.string().nullable(),
});

/** `anvil.room_event_find` hit — same committed-row fields, but no `duplicate`. */
const WireEventFindSchema = z.object({
  status: z.literal("ok"),
  event_id: z.string(),
  room_seq: z.number().int().positive(),
  to: z.string(),
  substate: z.string().nullable(),
  correlation_id: z.string(),
  causation_id: z.string().nullable(),
});

const WireGrantSchema = z.object({
  grant_id: z.string(),
  subject_kind: z.enum(["agent", "device", "user"]),
  subject_ref: z.string(),
  capability: z.string(),
  scope_kind: z.enum(["global", "room"]),
  scope_room_id: z.string().nullable(),
  correlation_id: z.string().nullable(),
  granted_by: z.string(),
  issued_at: z.string(),
  expires_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
});

const WireMintSchema = z.object({
  status: z.literal("ok"),
  grant: WireGrantSchema,
});

const WireGrantGetSchema = z.object({
  status: z.literal("ok"),
  grant: WireGrantSchema,
});

const WireDomainStatusSchema = z.object({
  status: z.enum([
    "binding_not_found",
    "room_not_found",
    "room_not_active",
    "grant_not_found",
    "event_not_found",
    "capability_denied",
    "not_participant",
    "validation",
  ]),
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

export function createNeoWriteApiGateway(options: NeoWriteApiOptions): ExecutionAuthorityGateway {
  const tools = { ...NEO_WRITE_API_TOOLS, ...options.tools };
  const subjectLabel = anvilSubjectLabel(options.subject);

  /**
   * Domain outcomes become typed errors/undefined — the same domain surface
   * the SQL gateway produces, so the machine never learns the transport.
   * `grant_not_found`/`binding_not_found` map to undefined per the gateway
   * contract; authority denials map to the shared capability errors.
   */
  async function callTool(
    tool: string,
    args: Record<string, unknown>,
    context: { roomId?: string; absent: "binding" | "grant" | "event" | "none" },
  ): Promise<Record<string, unknown> | undefined> {
    const structured = await postToolCall(options, tool, {
      subject: subjectLabel,
      ...args,
    });
    const domain = WireDomainStatusSchema.safeParse(structured);
    if (domain.success) {
      switch (domain.data.status) {
        case "binding_not_found":
          if (context.absent === "binding") return undefined;
          throw new RoomNotFoundError(context.roomId ?? "unknown");
        case "grant_not_found":
          if (context.absent === "grant") return undefined;
          throw new RoomNotFoundError(context.roomId ?? "unknown");
        case "event_not_found":
          if (context.absent === "event") return undefined;
          throw new RoomNotFoundError(context.roomId ?? "unknown");
        case "room_not_found":
          throw new RoomNotFoundError(context.roomId ?? "unknown");
        case "room_not_active":
          throw new RoomNotActiveError(context.roomId ?? "unknown", "not_active");
        case "capability_denied":
        case "not_participant":
          throw new RoomCapabilityDeniedError(
            "room.execute",
            subjectLabel,
            context.roomId ?? "unknown",
          );
        case "validation":
          throw new DatabaseUnavailableError("neo write api rejected the call as invalid");
      }
    }
    return structured;
  }

  function parseWire<Schema extends z.ZodType>(
    schema: Schema,
    structured: Record<string, unknown> | undefined,
  ): z.infer<Schema> {
    const parsed = schema.safeParse(structured);
    if (!parsed.success) {
      throw new DatabaseUnavailableError("neo write api returned malformed payload", {
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  return {
    producer: subjectLabel,

    async resolveExecution(executionId) {
      const structured = await callTool(
        tools.resolve,
        { execution_id: executionId },
        { absent: "binding" },
      );
      if (structured === undefined) return undefined;
      const wire = parseWire(WireResolveSchema, structured);
      return {
        execution_id: wire.execution_id,
        binding_id: wire.binding_id,
        binding_status: wire.binding_status,
        room_id: wire.room_id,
        room_internal_id: wire.room_internal_id,
        room_status: wire.room_status,
        correlation_id: wire.correlation_id,
        last_transition: wire.last_transition,
      } satisfies ResolvedExecutionBinding;
    },

    async findTransition(roomInternalId, idempotencyKey) {
      const structured = await callTool(
        tools.eventFind,
        { idempotency_key: idempotencyKey, room_internal_id: roomInternalId },
        { absent: "event" },
      );
      if (structured === undefined) return undefined;
      const wire = parseWire(WireEventFindSchema, structured);
      return {
        event_id: wire.event_id,
        room_seq: wire.room_seq,
        duplicate: true,
        to: wire.to,
        substate: wire.substate,
        correlation_id: wire.correlation_id,
        causation_id: wire.causation_id,
      };
    },

    async appendTransition(input): Promise<CommittedTransition> {
      const structured = await callTool(
        tools.append,
        {
          room_id: input.room_id,
          execution_id: input.execution_id,
          execution_binding_id: input.binding_id,
          kind: "execution.transition",
          from: input.from,
          to: input.to,
          substate: input.substate,
          reason: input.reason,
          actor: input.actor,
          ...(input.grant_id === undefined ? {} : { grant_id: input.grant_id }),
          ...input.extra,
          correlation_id: input.correlation_id,
          causation_id: input.causation_id,
          idempotency_key: input.idempotency_key,
          ...(input.occurred_at === undefined ? {} : { occurred_at: input.occurred_at }),
        },
        { roomId: input.room_id, absent: "none" },
      );
      const wire = parseWire(WireAppendSchema, structured);
      return {
        event_id: wire.event_id,
        room_seq: wire.room_seq,
        duplicate: wire.duplicate,
        to: wire.to,
        substate: wire.substate,
        correlation_id: wire.correlation_id,
        causation_id: wire.causation_id,
      };
    },

    async mintGrant(input) {
      const structured = await callTool(
        tools.grantMint,
        {
          execution_id: input.resolved.execution_id,
          room_id: input.resolved.room_id,
          action: input.action,
          capability: `execution.${input.action}`,
          principal: input.principal,
          correlation_id: input.resolved.correlation_id,
          expires_at: input.expires_at,
        },
        { roomId: input.resolved.room_id, absent: "none" },
      );
      const wire = parseWire(WireMintSchema, structured);
      return wire.grant;
    },

    async findGrant(grantId) {
      const structured = await callTool(tools.grantGet, { grant_id: grantId }, { absent: "grant" });
      if (structured === undefined) return undefined;
      const wire = parseWire(WireGrantGetSchema, structured);
      return wire.grant;
    },
  };
}

async function postToolCall(
  options: NeoWriteApiOptions,
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
              name: "paseo-hub-execution-convergence",
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
    throw new DatabaseUnavailableError("neo write api unreachable", { cause: error });
  }
  if (!response.ok) {
    throw new DatabaseUnavailableError(`neo write api answered HTTP ${response.status}`);
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    throw new DatabaseUnavailableError("neo write api returned non-JSON", { cause: error });
  }
  const envelope = JsonRpcResponseSchema.safeParse(parsed);
  if (!envelope.success || envelope.data.error !== undefined) {
    throw new DatabaseUnavailableError("neo write api protocol failure");
  }
  const result = envelope.data.result;
  if (result === undefined) {
    throw new DatabaseUnavailableError("neo write api returned no result");
  }
  const structured = extractStructured(result);
  if (result.isError === true || structured === undefined) {
    throw new DatabaseUnavailableError("neo write api tool call failed");
  }
  return structured;
}

/**
 * Prefer `structuredContent`; fall back to a JSON-encoded text content block
 * for servers that only fill `content` (same tolerance as the read path).
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
