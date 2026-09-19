import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  embeddedDatabaseRuntime,
  type DatabaseRuntime,
  type QueryHandle,
  type QueryResult,
  type QueryRow,
} from "../db/runtime/index.js";
import {
  AnvilSubjectError,
  parseAnvilSubject,
  roomAuthorityFromEnvironment,
  RoomAuthorityConfigError,
  createRoomAuthorityReader,
  RoomCapabilityDeniedError,
  RoomNotFoundError,
} from "./index.js";

/**
 * Read-seam contract tests against a real Postgres (PGlite) carrying the C2
 * Room authority DDL verbatim for the tables the projection reads.
 */

const ROOM_A = "10000000-0000-4000-8000-0000000000a1";
const ROOM_B = "10000000-0000-4000-8000-0000000000b1";
const AGENT_READER = "10000000-0000-4000-8000-0000000000c1";
const AGENT_MEMBER = "10000000-0000-4000-8000-0000000000c2";
const CORRELATION = "10000000-0000-4000-8000-0000000000d1";

const ROOM_AUTHORITY_DDL = `
CREATE SCHEMA anvil;

CREATE TABLE anvil.agents (
    id         BIGSERIAL PRIMARY KEY,
    public_id  UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE
);

CREATE TABLE anvil.rooms (
    id              BIGSERIAL PRIMARY KEY,
    public_id       UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    project_ref     TEXT,
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'archived', 'closed')),
    next_seq        BIGINT NOT NULL DEFAULT 1 CHECK (next_seq >= 1),
    correlation_id  UUID NOT NULL DEFAULT gen_random_uuid(),
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE anvil.room_participants (
    id              BIGSERIAL PRIMARY KEY,
    public_id       UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    room_id         BIGINT NOT NULL REFERENCES anvil.rooms(id) ON DELETE CASCADE,
    agent_id        BIGINT NOT NULL REFERENCES anvil.agents(id) ON DELETE RESTRICT,
    role            TEXT NOT NULL DEFAULT 'participant',
    joined_seq      BIGINT,
    left_seq        BIGINT,
    acked_seq       BIGINT NOT NULL DEFAULT 0,
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    left_at         TIMESTAMPTZ,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE anvil.room_events (
    id                  BIGSERIAL PRIMARY KEY,
    public_id           UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    room_id             BIGINT NOT NULL REFERENCES anvil.rooms(id) ON DELETE CASCADE,
    room_seq            BIGINT NOT NULL,
    kind                TEXT NOT NULL
                        CHECK (kind IN ('message', 'handoff', 'approval',
                                        'evidence_ref', 'execution', 'system')),
    producer            TEXT NOT NULL,
    producer_agent_id   BIGINT REFERENCES anvil.agents(id) ON DELETE SET NULL,
    payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
    link                JSONB NOT NULL,
    correlation_id      UUID NOT NULL,
    causation_id        TEXT,
    task_ref            UUID,
    campaign_id         TEXT,
    idempotency_key     TEXT NOT NULL,
    occurred_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (room_id, room_seq),
    UNIQUE (room_id, idempotency_key)
);

CREATE TABLE anvil.capability_grants (
    id               BIGSERIAL PRIMARY KEY,
    public_id        UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    subject_kind     TEXT NOT NULL CHECK (subject_kind IN ('agent', 'device', 'user')),
    subject_agent_id BIGINT REFERENCES anvil.agents(id) ON DELETE CASCADE,
    subject_ref      TEXT,
    capability       TEXT NOT NULL,
    scope_kind       TEXT NOT NULL DEFAULT 'global'
                     CHECK (scope_kind IN ('global', 'room')),
    scope_room_id    BIGINT REFERENCES anvil.rooms(id) ON DELETE CASCADE,
    granted_by       TEXT NOT NULL,
    correlation_id   UUID,
    expires_at       TIMESTAMPTZ,
    revoked_at       TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ( (subject_kind = 'agent' AND subject_agent_id IS NOT NULL)
         OR (subject_kind <> 'agent' AND subject_ref IS NOT NULL) ),
    CHECK ( (scope_kind = 'room' AND scope_room_id IS NOT NULL)
         OR (scope_kind = 'global' AND scope_room_id IS NULL) )
);
`;

describe("parseAnvilSubject", () => {
  it("accepts the three grantable producer forms", () => {
    assert.deepEqual(parseAnvilSubject(`agent:${AGENT_READER}`), {
      kind: "agent",
      publicId: AGENT_READER,
    });
    assert.deepEqual(parseAnvilSubject("machine:anvil-node-02"), {
      kind: "device",
      subjectRef: "machine:anvil-node-02",
    });
    assert.deepEqual(parseAnvilSubject("operator:nayte"), {
      kind: "user",
      subjectRef: "operator:nayte",
    });
  });

  it("rejects service identities, non-UUID agents, and malformed bindings", () => {
    for (const value of [
      "service:hub",
      "agent:not-a-uuid",
      "room:thing",
      "nocolon",
      "agent:",
      "",
    ]) {
      assert.throws(() => parseAnvilSubject(value), AnvilSubjectError, value);
    }
  });
});

describe("roomAuthorityFromEnvironment", () => {
  it("returns undefined when the seam is unconfigured", () => {
    assert.equal(roomAuthorityFromEnvironment({}), undefined);
  });

  it("fails closed at boot on a half-configured or malformed binding", () => {
    assert.throws(
      () =>
        roomAuthorityFromEnvironment({
          PASEO_HUB_ANVIL_DATABASE_URL: "postgres://localhost/anvil_core",
        }),
      RoomAuthorityConfigError,
    );
    assert.throws(
      () =>
        roomAuthorityFromEnvironment({
          PASEO_HUB_ANVIL_DATABASE_URL: "postgres://localhost/anvil_core",
          PASEO_HUB_ANVIL_SUBJECT: "service:hub",
        }),
      RoomAuthorityConfigError,
    );
  });

  it("fails closed when both authority transports are configured", () => {
    assert.throws(
      () =>
        roomAuthorityFromEnvironment({
          PASEO_HUB_ANVIL_DATABASE_URL: "postgres://localhost/anvil_core",
          PASEO_HUB_ANVIL_READ_API_URL: "https://neo.example.ts.net:8443/mcp",
          PASEO_HUB_ANVIL_READ_API_TOKEN: "tok",
          PASEO_HUB_ANVIL_SUBJECT: "machine:anvil-node-01",
        }),
      RoomAuthorityConfigError,
    );
  });

  it("fails closed on a partial read-api binding", () => {
    for (const env of [
      { PASEO_HUB_ANVIL_READ_API_TOKEN: "tok" },
      {
        PASEO_HUB_ANVIL_READ_API_URL: "https://neo.example.ts.net:8443/mcp",
        PASEO_HUB_ANVIL_SUBJECT: "machine:anvil-node-01",
      },
      {
        PASEO_HUB_ANVIL_READ_API_URL: "https://neo.example.ts.net:8443/mcp",
        PASEO_HUB_ANVIL_READ_API_TOKEN: "tok",
      },
      {
        PASEO_HUB_ANVIL_READ_API_URL: "https://neo.example.ts.net:8443/mcp",
        PASEO_HUB_ANVIL_READ_API_TOKEN: "tok",
        PASEO_HUB_ANVIL_READ_API_TOKEN_FILE: "/tmp/token",
        PASEO_HUB_ANVIL_SUBJECT: "machine:anvil-node-01",
      },
      {
        PASEO_HUB_ANVIL_READ_API_URL: "http://169.254.1.1:8787/mcp",
        PASEO_HUB_ANVIL_READ_API_TOKEN: "tok",
        PASEO_HUB_ANVIL_SUBJECT: "machine:anvil-node-01",
      },
      {
        PASEO_HUB_ANVIL_READ_API_URL: "https://neo.example.ts.net:8443/mcp",
        PASEO_HUB_ANVIL_READ_API_TOKEN: "tok",
        PASEO_HUB_ANVIL_SUBJECT: "machine:anvil-node-01",
        PASEO_HUB_ANVIL_PROJECTION_STALE_MS: "soon",
      },
    ]) {
      assert.throws(() => roomAuthorityFromEnvironment(env), RoomAuthorityConfigError);
    }
  });

  it("binds the read-api transport when fully configured", () => {
    const source = roomAuthorityFromEnvironment({
      PASEO_HUB_ANVIL_READ_API_URL: "https://neo.example.ts.net:8443/mcp",
      PASEO_HUB_ANVIL_READ_API_TOKEN: "tok",
      PASEO_HUB_ANVIL_SUBJECT: "machine:anvil-node-01",
      PASEO_HUB_ANVIL_PROJECTION_STALE_MS: "15000",
    });
    assert.ok(source !== undefined);
    assert.deepEqual(source.subject, { kind: "device", subjectRef: "machine:anvil-node-01" });
    assert.equal(source.staleAfterMs, 15_000);
    return source.close();
  });
});

describe("RoomAuthorityReader over real Postgres", () => {
  let runtime: DatabaseRuntime;
  let directory: string;
  let roomAInternal: number;
  let agentReaderInternal: number;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "hub-room-projection-"));
    const bundle = await embeddedDatabaseRuntime(join(directory, "database"));
    runtime = bundle.runtime;
    // PGlite prepared statements are single-statement; apply the DDL per
    // statement (the test DDL carries no function bodies or dollar-quoting).
    for (const statement of ROOM_AUTHORITY_DDL.split(";")) {
      if (statement.trim().length > 0) await runtime.query(statement);
    }
    await runtime.query(`INSERT INTO anvil.agents (public_id) VALUES ($1), ($2)`, [
      AGENT_READER,
      AGENT_MEMBER,
    ]);
    await runtime.query(
      `INSERT INTO anvil.rooms (public_id, project_ref, status, correlation_id)
       VALUES ($1, 'anvil', 'active', $2), ($3, NULL, 'archived', $2)`,
      [ROOM_A, CORRELATION, ROOM_B],
    );
    const rooms = await runtime.query<{ id: number }>(
      `SELECT id FROM anvil.rooms WHERE public_id = $1`,
      [ROOM_A],
    );
    roomAInternal = rooms.rows[0]!.id;
    const agents = await runtime.query<{ id: number }>(
      `SELECT id FROM anvil.agents WHERE public_id = $1`,
      [AGENT_READER],
    );
    agentReaderInternal = agents.rows[0]!.id;
    // Events carry a legal gap (rolled-back seq 3) to prove ordering, not
    // contiguity, is the contract.
    for (const [seq, kind] of [
      [1, "system"],
      [2, "message"],
      [4, "message"],
      [5, "handoff"],
    ] as const) {
      await runtime.query(
        `INSERT INTO anvil.room_events
           (room_id, room_seq, kind, producer, payload, link, correlation_id,
            idempotency_key, occurred_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, '{}'::jsonb, $6, $7, now())`,
        [
          roomAInternal,
          seq,
          kind,
          `agent:${AGENT_MEMBER}`,
          JSON.stringify({ n: seq }),
          CORRELATION,
          `agent:${AGENT_MEMBER}:${seq}`,
        ],
      );
    }
    const members = await runtime.query<{ id: number }>(
      `SELECT id FROM anvil.agents WHERE public_id = $1`,
      [AGENT_MEMBER],
    );
    await runtime.query(
      `INSERT INTO anvil.room_participants (room_id, agent_id, role, joined_seq, acked_seq)
       VALUES ($1, $2, 'worker', 1, 2)`,
      [roomAInternal, members.rows[0]!.id],
    );
    // A left participant must not appear in the snapshot.
    await runtime.query(
      `INSERT INTO anvil.room_participants (room_id, agent_id, role, joined_seq, left_seq)
       VALUES ($1, $2, 'observer', 1, 4)`,
      [roomAInternal, agentReaderInternal],
    );
  }, 60_000);

  afterAll(async () => {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  });

  function readerFor(subject: string) {
    return createRoomAuthorityReader(runtime, parseAnvilSubject(subject));
  }

  it("lists only rooms the bound subject can read", async () => {
    await grant("device", "machine:hub", "room.read", "global");
    const listed = await readerFor("machine:hub").listReadableRooms();
    assert.deepEqual(listed.value.map((room) => room.room_id).sort(), [ROOM_A, ROOM_B].sort());
    const roomA = listed.value.find((room) => room.room_id === ROOM_A);
    assert.equal(roomA?.latest_seq, 5);
    assert.equal(roomA?.status, "active");
    assert.equal(roomA?.correlation_id, CORRELATION);
    assert.ok(!Number.isNaN(Date.parse(listed.observed_at)));

    assert.deepEqual((await readerFor("machine:nobody").listReadableRooms()).value, []);
  });

  it("grants room-scoped reads to the target room only", async () => {
    await grant("user", "operator:viewer", "room.read", "room");
    const reader = readerFor("operator:viewer");
    assert.deepEqual(
      (await reader.listReadableRooms()).value.map((room) => room.room_id),
      [ROOM_A],
    );
    await assert.rejects(() => reader.readSnapshot(ROOM_B), RoomCapabilityDeniedError);
  });

  it("reads a snapshot with active participants only", async () => {
    await grant("agent", null, "room.read", "global", undefined, agentReaderInternal);
    const snapshot = await readerFor(`agent:${AGENT_READER}`).readSnapshot(ROOM_A);
    assert.equal(snapshot.value.room.room_id, ROOM_A);
    assert.equal(snapshot.value.room.latest_seq, 5);
    assert.equal(snapshot.value.participants.length, 1);
    assert.equal(snapshot.value.participants[0]?.agent_id, AGENT_MEMBER);
    assert.equal(snapshot.value.participants[0]?.role, "worker");
    assert.equal(snapshot.value.participants[0]?.acked_seq, 2);
    assert.ok(!Number.isNaN(Date.parse(snapshot.observed_at)));
  });

  it("replays events strictly after the cursor in ascending room_seq order", async () => {
    const reader = readerFor(`agent:${AGENT_READER}`);
    const page = await reader.replayEvents(ROOM_A, 0, 500);
    assert.deepEqual(
      page.value.events.map((event) => event.room_seq),
      [1, 2, 4, 5],
    );
    assert.equal(page.value.latestSeq, 5);
    assert.ok(!Number.isNaN(Date.parse(page.observed_at)));

    const reconnected = await reader.replayEvents(ROOM_A, 2, 500);
    assert.deepEqual(
      reconnected.value.events.map((event) => event.room_seq),
      [4, 5],
    );

    const tail = await reader.replayEvents(ROOM_A, 5, 500);
    assert.deepEqual(tail.value.events, []);
    assert.equal(tail.value.latestSeq, 5);
  });

  it("replays deterministically: re-issuing a cursor yields the identical page", async () => {
    const reader = readerFor(`agent:${AGENT_READER}`);
    const first = await reader.replayEvents(ROOM_A, 1, 2);
    const second = await reader.replayEvents(ROOM_A, 1, 2);
    assert.deepEqual(second.value.events, first.value.events);
    assert.deepEqual(
      first.value.events.map((event) => event.room_seq),
      [2, 4],
    );
    const continuation = await reader.replayEvents(ROOM_A, 4, 2);
    assert.deepEqual(
      continuation.value.events.map((event) => event.room_seq),
      [5],
    );
  });

  it("collapses re-delivered rows on (room_id, room_seq)", async () => {
    const reader = createRoomAuthorityReader(
      new ReDeliveringHandle(runtime),
      parseAnvilSubject(`agent:${AGENT_READER}`),
    );
    const page = await reader.replayEvents(ROOM_A, 0, 500);
    assert.deepEqual(
      page.value.events.map((event) => event.room_seq),
      [1, 2, 4, 5],
    );
  });

  it("denies reads without a durable grant, and for expired, revoked, or wrong-capability grants", async () => {
    const reader = readerFor("machine:ungranted");
    await assert.rejects(() => reader.readSnapshot(ROOM_A), RoomCapabilityDeniedError);
    await assert.rejects(() => reader.replayEvents(ROOM_A, 0, 10), RoomCapabilityDeniedError);

    await grant("device", "machine:expired", "room.read", "global", new Date("2020-01-01"));
    await assert.rejects(
      () => readerFor("machine:expired").readSnapshot(ROOM_A),
      RoomCapabilityDeniedError,
    );

    const revoked = await grant("device", "machine:revoked", "room.read", "global");
    await runtime.query(`UPDATE anvil.capability_grants SET revoked_at = now() WHERE id = $1`, [
      revoked,
    ]);
    await assert.rejects(
      () => readerFor("machine:revoked").readSnapshot(ROOM_A),
      RoomCapabilityDeniedError,
    );

    await grant("device", "machine:writer", "room.message", "global");
    await assert.rejects(
      () => readerFor("machine:writer").readSnapshot(ROOM_A),
      RoomCapabilityDeniedError,
    );
  });

  it("denies agent subjects that do not resolve to a durable anvil.agents row", async () => {
    await assert.rejects(
      () => readerFor("agent:10000000-0000-4000-8000-0000000000ff").readSnapshot(ROOM_A),
      RoomCapabilityDeniedError,
    );
  });

  it("reports unknown rooms distinctly from denied rooms", async () => {
    await assert.rejects(
      () => readerFor(`agent:${AGENT_READER}`).readSnapshot("10000000-0000-4000-8000-0000000000ff"),
      RoomNotFoundError,
    );
  });

  async function grant(
    subjectKind: "agent" | "device" | "user",
    subjectRef: string | null,
    capability: string,
    scopeKind: "global" | "room",
    expiresAt?: Date,
    subjectAgentId?: number,
  ): Promise<number> {
    const result = await runtime.query<{ id: number }>(
      `INSERT INTO anvil.capability_grants
         (subject_kind, subject_agent_id, subject_ref, capability,
          scope_kind, scope_room_id, granted_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'operator:test', $7)
       RETURNING id`,
      [
        subjectKind,
        subjectAgentId ?? null,
        subjectRef,
        capability,
        scopeKind,
        scopeKind === "room" ? roomAInternal : null,
        expiresAt ?? null,
      ],
    );
    return result.rows[0]!.id;
  }
});

/** Simulates transport redelivery: replay pages return every row twice. */
class ReDeliveringHandle implements QueryHandle {
  constructor(private readonly inner: DatabaseRuntime) {}

  async query<Row extends QueryRow = QueryRow>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const result = await this.inner.query<Row>(sql, params);
    if (sql.includes("FROM anvil.room_events") && sql.includes("room_seq >")) {
      return { rows: [...result.rows, ...result.rows], rowCount: result.rows.length * 2 };
    }
    return result;
  }
}
