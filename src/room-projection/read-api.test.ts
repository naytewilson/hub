import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { z } from "zod";
import { DatabaseUnavailableError } from "../db/errors.js";
import type { AnvilRoomSubject } from "./contract.js";
import {
  createNeoReadApiReader,
  NEO_READ_API_TOOLS,
  RoomCapabilityDeniedError,
  RoomNotFoundError,
} from "./index.js";

const ROOM_ID = "84af3583-23ff-4fcc-9838-ed3262499be2";
const CORRELATION = "f83dc934-02a0-4849-8de7-699110be24ed";
const OBSERVED = "2026-09-19T12:00:00.000Z";
const SUBJECT: AnvilRoomSubject = { kind: "device", subjectRef: "machine:test" };

const ROOM_ROW = {
  room_id: ROOM_ID,
  project_ref: null,
  status: "active",
  correlation_id: CORRELATION,
  latest_seq: 5,
  created_at: "2026-09-15T00:00:00.000Z",
  updated_at: "2026-09-15T00:00:01.000Z",
};

const EVENT_ROW = {
  event_id: "845e9d26-7977-45e1-bc69-d80a7b55a9cc",
  room_id: ROOM_ID,
  room_seq: 4,
  kind: "sieve.projection",
  producer: "service:sieve-projector",
  payload: {
    observed_at: "2026-09-19T11:00:00.000Z",
    source: "sieve:8899/dashboard/data",
    digest: "sha256:a",
    stale_after_ms: 15000,
  },
  link: {},
  correlation_id: CORRELATION,
  causation_id: null,
  task_ref: null,
  campaign_id: null,
  idempotency_key: "sieve-projector:4",
  occurred_at: "2026-09-19T11:00:00.000Z",
  created_at: "2026-09-19T11:00:01.000Z",
};

describe("Neo read-API RoomAuthorityReader", () => {
  it("calls anvil.room_list with the bound subject and returns the observed read", async () => {
    const fetch = fakeFetch((call) => {
      assert.equal(call.method, "tools/call");
      assert.equal(call.name, "anvil.room_list");
      assert.deepEqual(call.args, { subject: "machine:test" });
      return okResult({ status: "ok", observed_at: OBSERVED, rooms: [ROOM_ROW] });
    });
    const reader = createNeoReadApiReader({
      url: "https://neo.example.ts.net:8443/mcp",
      token: "tok-123",
      subject: SUBJECT,
      fetchFn: fetch.fn,
    });

    const read = await reader.listReadableRooms();
    assert.equal(read.observed_at, OBSERVED);
    assert.equal(read.value.length, 1);
    assert.equal(read.value[0]?.room_id, ROOM_ID);
    assert.equal(read.value[0]?.latest_seq, 5);

    assert.equal(fetch.calls.length, 1);
    assert.equal(fetch.calls[0]?.headers["authorization"], "Bearer tok-123");
    assert.equal(fetch.calls[0]?.headers["mcp-protocol-version"], "2026-07-28");
  });

  it("falls back to response-receipt time when the service omits observed_at", async () => {
    const fetch = fakeFetch(() => okResult({ status: "ok", rooms: [] }));
    const reader = createNeoReadApiReader({
      url: "https://neo.example.ts.net:8443/mcp",
      token: "tok",
      subject: SUBJECT,
      fetchFn: fetch.fn,
    });
    const before = Date.now();
    const read = await reader.listReadableRooms();
    const stamp = Date.parse(read.observed_at);
    assert.ok(!Number.isNaN(stamp));
    assert.ok(stamp >= before && stamp <= Date.now());
  });

  it("decodes snapshots with participants", async () => {
    const fetch = fakeFetch((call) => {
      assert.equal(call.name, "anvil.room_snapshot");
      assert.deepEqual(call.args, { subject: "machine:test", room_id: ROOM_ID });
      return okResult({
        status: "ok",
        observed_at: OBSERVED,
        room: ROOM_ROW,
        participants: [
          {
            participant_id: "84af3583-23ff-4fcc-9838-ed3262499be2",
            agent_id: "f83dc934-02a0-4849-8de7-699110be24ed",
            role: "worker",
            joined_seq: 1,
            acked_seq: 3,
            joined_at: "2026-09-15T00:00:00.000Z",
          },
        ],
      });
    });
    const reader = createNeoReadApiReader({
      url: "https://neo.example.ts.net:8443/mcp",
      token: "tok",
      subject: SUBJECT,
      fetchFn: fetch.fn,
    });
    const read = await reader.readSnapshot(ROOM_ID);
    assert.equal(read.observed_at, OBSERVED);
    assert.equal(read.value.room.room_id, ROOM_ID);
    assert.equal(read.value.participants[0]?.role, "worker");
    assert.equal(read.value.participants[0]?.acked_seq, 3);
  });

  it("replays events with cursor arguments and passes authority kinds through verbatim", async () => {
    const fetch = fakeFetch((call) => {
      assert.equal(call.name, "anvil.room_events");
      assert.deepEqual(call.args, {
        subject: "machine:test",
        room_id: ROOM_ID,
        after: 2,
        limit: 500,
      });
      return okResult({
        status: "ok",
        observed_at: OBSERVED,
        room: ROOM_ROW,
        latest_seq: 5,
        events: [EVENT_ROW],
      });
    });
    const reader = createNeoReadApiReader({
      url: "https://neo.example.ts.net:8443/mcp",
      token: "tok",
      subject: SUBJECT,
      fetchFn: fetch.fn,
    });
    const read = await reader.replayEvents(ROOM_ID, 2, 500);
    assert.equal(read.observed_at, OBSERVED);
    assert.equal(read.value.latestSeq, 5);
    assert.equal(read.value.events.length, 1);
    // kind passes through verbatim — Hub never gates the authority taxonomy
    assert.equal(read.value.events[0]?.kind, "sieve.projection");
    assert.equal(read.value.events[0]?.room_seq, 4);
    assert.equal(read.value.room.room_id, ROOM_ID);
  });

  it("collapses re-delivered (room_id, room_seq) pairs like the SQL reader", async () => {
    const fetch = fakeFetch(() =>
      okResult({
        status: "ok",
        room: ROOM_ROW,
        latest_seq: 5,
        events: [EVENT_ROW, { ...EVENT_ROW, event_id: "945e9d26-7977-45e1-bc69-d80a7b55a9cd" }],
      }),
    );
    const reader = createNeoReadApiReader({
      url: "https://neo.example.ts.net:8443/mcp",
      token: "tok",
      subject: SUBJECT,
      fetchFn: fetch.fn,
    });
    const read = await reader.replayEvents(ROOM_ID, 0, 500);
    assert.equal(read.value.events.length, 1);
  });

  it("maps domain outcomes onto RoomNotFoundError / RoomCapabilityDeniedError", async () => {
    const cases: Array<[string, (error: unknown) => boolean]> = [
      ["room_not_found", (error) => error instanceof RoomNotFoundError],
      ["capability_denied", (error) => error instanceof RoomCapabilityDeniedError],
    ];
    for (const [status, matches] of cases) {
      const fetch = fakeFetch(() => okResult({ status }));
      const reader = createNeoReadApiReader({
        url: "https://neo.example.ts.net:8443/mcp",
        token: "tok",
        subject: SUBJECT,
        fetchFn: fetch.fn,
      });
      await assert.rejects(() => reader.readSnapshot(ROOM_ID), matches);
    }
  });

  it("reads structuredContent and tolerates text-only content fallback", async () => {
    const fetch = fakeFetch(() => ({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: "ok", observed_at: OBSERVED, rooms: [] }),
          },
        ],
      },
    }));
    const reader = createNeoReadApiReader({
      url: "https://neo.example.ts.net:8443/mcp",
      token: "tok",
      subject: SUBJECT,
      fetchFn: fetch.fn,
    });
    const read = await reader.listReadableRooms();
    assert.equal(read.observed_at, OBSERVED);
  });

  it("fails closed on transport, protocol, and shape violations", async () => {
    const responses: unknown[] = [
      new Error("tcp reset"), // thrown by fetch itself
      new HttpFailure(503), // non-2xx
      { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "boom" } }, // JSON-RPC error
      { jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "x" }] } },
      { jsonrpc: "2.0", id: 1, result: {} }, // no structuredContent, no content
      {
        jsonrpc: "2.0",
        id: 1,
        result: { structuredContent: { status: "ok", rooms: [{ bogus: true }] } },
      },
      "not json at all",
    ];
    for (const response of responses) {
      const fetch = fakeFetch(() => response);
      const reader = createNeoReadApiReader({
        url: "https://neo.example.ts.net:8443/mcp",
        token: "tok",
        subject: SUBJECT,
        fetchFn: fetch.fn,
      });
      await assert.rejects(() => reader.listReadableRooms(), DatabaseUnavailableError);
    }
  });

  it("honours tool-name overrides for coordinated drift", async () => {
    const fetch = fakeFetch((call) => {
      assert.equal(call.name, "anvil.room.list.v2");
      return okResult({ status: "ok", rooms: [] });
    });
    const reader = createNeoReadApiReader({
      url: "https://neo.example.ts.net:8443/mcp",
      token: "tok",
      subject: SUBJECT,
      fetchFn: fetch.fn,
      tools: { list: "anvil.room.list.v2" },
    });
    await reader.listReadableRooms();
    assert.equal(NEO_READ_API_TOOLS.list, "anvil.room_list");
  });
});

class HttpFailure extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

interface ToolCall {
  method: string;
  name: string;
  args: Record<string, unknown>;
  headers: Record<string, string>;
}

const ToolCallBodySchema = z.object({
  method: z.string(),
  params: z.object({
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()),
  }),
});

function okResult(structuredContent: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id: 1, result: { structuredContent } };
}

function fakeFetch(respond: (call: ToolCall) => unknown): {
  fn: typeof globalThis.fetch;
  calls: ToolCall[];
} {
  const calls: ToolCall[] = [];
  const fn = (async (input: unknown, init?: RequestInit) => {
    void input;
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const body = ToolCallBodySchema.parse(JSON.parse(bodyText));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: ToolCall = {
      method: body.method,
      name: body.params.name,
      args: body.params.arguments,
      headers,
    };
    calls.push(call);
    const outcome = respond(call);
    if (outcome instanceof HttpFailure) {
      return new Response("unavailable", { status: outcome.status });
    }
    if (outcome instanceof Error) throw outcome;
    if (typeof outcome === "string") {
      return new Response(outcome, { status: 200 });
    }
    return new Response(JSON.stringify(outcome), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fn, calls };
}
