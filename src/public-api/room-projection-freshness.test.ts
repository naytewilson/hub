import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { z } from "zod";
import type { ApiKeyScope } from "../auth/api-key-contract.js";
import type { OperationAuthenticator } from "../auth/operation-auth.js";
import { createPublicOperations } from "../public-operations/index.js";
import type {
  PublicOperationCapabilities,
  PublicOperationRepository,
} from "../public-operations/types.js";
import {
  createNeoReadApiReader,
  createRoomAuthoritySourceForReader,
  parseAnvilSubject,
} from "../room-projection/index.js";
import { createPublicApi } from "./index.js";

/**
 * End-to-end freshness contract through the real serving stack
 * (HTTP route → operations → Neo read-API MCP transport → freshness math),
 * against a contract-faithful stub of the i1 read service. Exercises the
 * A6 kill/recover shape: when the observed projection stops advancing,
 * `stale` flips true while the last `observed_at` remains visible; when it
 * resumes, freshness recovers on the same room_seq timeline.
 */

const ROOM_ID = "84af3583-23ff-4fcc-9838-ed3262499be2";
const CORRELATION = "f83dc934-02a0-4849-8de7-699110be24ed";
const ROOM = {
  room_id: ROOM_ID,
  project_ref: null,
  status: "active",
  correlation_id: CORRELATION,
  latest_seq: 5,
  created_at: "2026-09-15T00:00:00.000Z",
  updated_at: "2026-09-15T00:00:00.000Z",
};

const SIEVE_STALE_AFTER_MS = 15_000;

describe("Room projection freshness over the Neo read-API transport", () => {
  it("serves the A6 kill/recover shape: stale on freeze, recovery on resume, one timeline", async () => {
    // Serve-time clock Hub controls; the stub's observation clock is what
    // freezes when "SIEVE" is killed.
    let serveNow = Date.parse("2026-09-19T12:00:00.000Z");
    let sieveAlive = true;
    let sieveObservedAt = Date.parse("2026-09-19T11:59:59.000Z");

    const fetchFn = (async (_input: unknown, init?: RequestInit) => {
      const body = ToolCallSchema.parse(
        JSON.parse(typeof init?.body === "string" ? init.body : ""),
      );
      assert.equal(body.params.name, "anvil.room_events");
      const event = {
        event_id: "845e9d26-7977-45e1-bc69-d80a7b55a9cc",
        room_id: ROOM_ID,
        room_seq: 5,
        kind: "sieve.projection",
        producer: "service:sieve-projector",
        payload: {
          observed_at: new Date(sieveObservedAt).toISOString(),
          source: "sieve:8899/dashboard/data",
          digest: "sha256:abc",
          stale_after_ms: SIEVE_STALE_AFTER_MS,
        },
        link: {},
        correlation_id: CORRELATION,
        causation_id: null,
        task_ref: null,
        campaign_id: null,
        idempotency_key: "sieve-projector:5",
        occurred_at: new Date(sieveObservedAt).toISOString(),
        created_at: "2026-09-19T11:59:59.500Z",
      };
      return json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          structuredContent: {
            status: "ok",
            observed_at: new Date(sieveObservedAt).toISOString(),
            room: ROOM,
            latest_seq: 5,
            events: [event],
          },
        },
      });
    }) as typeof globalThis.fetch;

    const subject = parseAnvilSubject("machine:anvil-node-02");
    const roomAuthority = createRoomAuthoritySourceForReader(
      createNeoReadApiReader({
        url: "https://neo.example.ts.net:8443/mcp",
        token: "test-token",
        subject,
        fetchFn,
      }),
      subject,
      undefined,
      30_000,
    );
    const api = createPublicApi(
      { status: "enabled", authenticator: authenticator() },
      createPublicOperations(unusedRepository(), capabilities(roomAuthority), {
        nowDate: () => new Date(serveNow),
      }),
    );
    const getEvents = () =>
      api.handle(
        new Request(`https://hub.test/api/v1/rooms/${ROOM_ID}/events?after=0&limit=10`, {
          headers: { authorization: "Bearer valid" },
        }),
      );

    // SIEVE live: fresh projection.
    const live = RoomEventPage.parse(await (await getEvents()).json());
    assert.equal(live.stale, false);
    assert.equal(live.observed_at, "2026-09-19T11:59:59.000Z");
    assert.deepEqual(live.events[0]?.freshness, {
      observed_at: "2026-09-19T11:59:59.000Z",
      stale: false,
    });

    // Kill SIEVE: the authority retains the last committed event, but its
    // observation stops advancing while serve time moves past the budget.
    sieveAlive = false;
    serveNow += 60_000;
    void sieveAlive;

    const killed = RoomEventPage.parse(await (await getEvents()).json());
    assert.equal(killed.stale, true);
    // Last observed_at remains visible — the projection never lies about age.
    assert.equal(killed.observed_at, "2026-09-19T11:59:59.000Z");
    assert.deepEqual(killed.events[0]?.freshness, {
      observed_at: "2026-09-19T11:59:59.000Z",
      stale: true,
    });
    assert.equal(killed.events[0]?.room_seq, 5);

    // Restart: the writer resumes observing; freshness recovers on the same
    // room_seq timeline (no fork — next event continues the sequence).
    sieveAlive = true;
    sieveObservedAt = Date.parse("2026-09-19T12:01:00.000Z");
    void sieveAlive;
    const recovered = RoomEventPage.parse(await (await getEvents()).json());
    assert.equal(recovered.stale, false);
    assert.equal(recovered.observed_at, "2026-09-19T12:01:00.000Z");
    assert.equal(recovered.events[0]?.room_seq, 5);
    assert.deepEqual(recovered.events[0]?.freshness, {
      observed_at: "2026-09-19T12:01:00.000Z",
      stale: false,
    });
  });
});

const ToolCallSchema = z.object({
  params: z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) }),
});

const RoomEventPage = z.looseObject({
  observed_at: z.string(),
  stale: z.boolean(),
  events: z.array(
    z.looseObject({
      room_seq: z.number(),
      freshness: z.object({ observed_at: z.string().nullable(), stale: z.boolean() }).optional(),
    }),
  ),
});

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function authenticator(): OperationAuthenticator {
  return {
    authorize(_request: Request, requiredScope: ApiKeyScope) {
      return Promise.resolve({
        status: "authorized",
        access: {
          kind: "apiKey",
          credentialId: "key-1",
          organizationId: "organization-1",
          scopes: [requiredScope],
        },
      });
    },
  };
}

function capabilities(
  roomAuthority: ReturnType<typeof createRoomAuthoritySourceForReader>,
): PublicOperationCapabilities {
  const unused = () => Promise.reject(new Error("room freshness test does not use this"));
  return {
    roomAuthority,
    configurationForProject: () => ({
      validateBundle: unused,
      insertManualBundleRevision: unused,
      activate: unused,
    }),
    validateBundleForOrganization: unused,
    dispatchManualEvent: unused,
  };
}

function unusedRepository(): PublicOperationRepository {
  const unused = () => Promise.reject(new Error("room freshness test does not use the repository"));
  return {
    listActiveProjects: unused,
    listConfigurationResources: unused,
    listSetupResources: unused,
    resolveManualRunProject: unused,
    resolveDeploymentProject: unused,
    findManualRun: unused,
    issueEnrollmentToken: unused,
  };
}
