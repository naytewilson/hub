import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import type { DaemonAgentStreamEvent, DaemonEvent } from "../daemons/protocol.js";
import type { AgentExecutionRecord } from "../db/types.js";
import { embeddedDatabaseRuntime, type DatabaseRuntime } from "../db/runtime/index.js";
import { RoomCapabilityDeniedError } from "../room-projection/reader.js";
import {
  CapabilityDeniedError,
  convergeTerminalReason,
  executionActionCapability,
  ExecutionNotBoundError,
  ExecutionNotFoundError,
  hubCredentialPrincipal,
  InvalidExecutionStateError,
  RoomNotActiveError,
} from "./contract.js";
import { createSqlExecutionAuthorityGateway } from "./gateway.js";
import { createExecutionConvergence, type ExecutionConvergence } from "./machine.js";
import { z } from "zod";
import { createNeoWriteApiGateway } from "./write-api.js";
import { DatabaseUnavailableError } from "../db/errors.js";

/**
 * I3/I4 contract tests against a real Postgres (PGlite) carrying the ANVIL
 * authority DDL verbatim (i1 v0_28 + v0_33) for the tables the write seam
 * touches. The Hub-local projection is a stub — authority rows are asserted
 * directly so causation/correlation/idempotency claims are proven, not faked.
 */

const ROOM = "20000000-0000-4000-8000-0000000000a1";
const ROOM_CLOSED = "20000000-0000-4000-8000-0000000000a2";
const CORRELATION = "20000000-0000-4000-8000-0000000000d1";
const BINDING_AGENT = "20000000-0000-4000-8000-0000000000c1";
const HUB_SUBJECT = "machine:hub-test";
const CALLER = hubCredentialPrincipal("credential-a");
const OTHER_CALLER = hubCredentialPrincipal("credential-b");
const DAEMON = "daemon-1";

const AUTHORITY_DDL = `
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

CREATE TABLE anvil.room_events (
    id                  BIGSERIAL PRIMARY KEY,
    public_id           UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    room_id             BIGINT NOT NULL REFERENCES anvil.rooms(id) ON DELETE CASCADE,
    room_seq            BIGINT NOT NULL,
    kind                TEXT NOT NULL
                        CHECK (kind IN ('message', 'handoff', 'approval',
                                        'evidence_ref', 'execution', 'system',
                                        'dispatch.received', 'execution.bound',
                                        'execution.rebound', 'execution.transition',
                                        'sieve.projection')),
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

CREATE TABLE anvil.execution_bindings (
    id                  BIGSERIAL PRIMARY KEY,
    public_id           UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    agent_id            BIGINT NOT NULL REFERENCES anvil.agents(id) ON DELETE RESTRICT,
    room_id             BIGINT REFERENCES anvil.rooms(id) ON DELETE SET NULL,
    execution_id        UUID,
    machine_id          TEXT,
    status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'replaced', 'released')),
    correlation_id      UUID,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
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

describe("execution convergence contract", () => {
  it("maps Hub terminal reasons onto the ANVIL vocabulary", () => {
    assert.equal(convergeTerminalReason(undefined), "completed_by_agent");
    assert.equal(convergeTerminalReason("idle_timeout"), "timed_out");
    assert.equal(convergeTerminalReason("whole_run_timeout"), "timed_out");
    assert.equal(convergeTerminalReason("agent_interrupted"), "agent_interrupted");
    assert.equal(convergeTerminalReason("daemon_disconnected"), "daemon_disconnected");
    assert.equal(convergeTerminalReason("operator_cancelled"), "operator_cancel");
    assert.equal(convergeTerminalReason("anything_else"), "dispatch_failed");
  });

  it("derives capability and principal names deterministically", () => {
    assert.equal(executionActionCapability("pause"), "execution.pause");
    assert.equal(hubCredentialPrincipal("abc"), "device:hub-credential:abc");
  });
});

describe("executionAuthorityFromEnvironment", () => {
  it("stays inert when no write var is set — including subject-only read config", async () => {
    const { executionAuthorityFromEnvironment } = await import("./index.js");
    assert.equal(executionAuthorityFromEnvironment({}), undefined);
    // PASEO_HUB_ANVIL_SUBJECT is shared with the READ seam — a production
    // read-only deployment must not activate or fail the write seam.
    assert.equal(
      executionAuthorityFromEnvironment({
        PASEO_HUB_ANVIL_SUBJECT: "machine:hub-test",
        PASEO_HUB_ANVIL_READ_API_URL: "https://neo.example.ts.net:8443/mcp",
        PASEO_HUB_ANVIL_READ_API_TOKEN: "tok",
      }),
      undefined,
    );
  });

  it("fails closed at boot on half-configured or conflicting write bindings", async () => {
    const { executionAuthorityFromEnvironment } = await import("./index.js");
    const { RoomAuthorityConfigError } = await import("../room-projection/index.js");
    for (const env of [
      { PASEO_HUB_ANVIL_WRITE_API_TOKEN: "tok" },
      { PASEO_HUB_ANVIL_WRITE_API_URL: "https://neo.example.ts.net:8443/mcp" },
      {
        PASEO_HUB_ANVIL_WRITE_API_URL: "https://neo.example.ts.net:8443/mcp",
        PASEO_HUB_ANVIL_WRITE_API_TOKEN: "tok",
        PASEO_HUB_ANVIL_WRITE_API_TOKEN_FILE: "/tmp/token",
        PASEO_HUB_ANVIL_SUBJECT: "machine:hub-test",
      },
      {
        PASEO_HUB_ANVIL_WRITE_API_URL: "https://neo.example.ts.net:8443/mcp",
        PASEO_HUB_ANVIL_WRITE_API_TOKEN: "tok",
        PASEO_HUB_ANVIL_WRITE_DATABASE_URL: "postgres://localhost/anvil_core",
        PASEO_HUB_ANVIL_SUBJECT: "machine:hub-test",
      },
      {
        PASEO_HUB_ANVIL_WRITE_API_URL: "https://neo.example.ts.net:8443/mcp",
        PASEO_HUB_ANVIL_WRITE_API_TOKEN: "tok",
        PASEO_HUB_ANVIL_SUBJECT: "service:hub",
      },
      {
        PASEO_HUB_ANVIL_WRITE_API_URL: "https://neo.example.ts.net:8443/mcp",
        PASEO_HUB_ANVIL_WRITE_API_TOKEN: "tok",
      },
    ]) {
      assert.throws(
        () => executionAuthorityFromEnvironment(env),
        RoomAuthorityConfigError,
        JSON.stringify(env),
      );
    }
  });

  it("binds the write-api transport when fully configured", async () => {
    const { executionAuthorityFromEnvironment } = await import("./index.js");
    const source = executionAuthorityFromEnvironment({
      PASEO_HUB_ANVIL_WRITE_API_URL: "https://neo.example.ts.net:8443/mcp",
      PASEO_HUB_ANVIL_WRITE_API_TOKEN: "tok",
      PASEO_HUB_ANVIL_SUBJECT: "machine:hub-test",
    });
    assert.ok(source !== undefined);
    assert.deepEqual(source.subject, { kind: "device", subjectRef: "machine:hub-test" });
    return source.close();
  });
});

describe("neo write api transport", () => {
  const SUBJECT = { kind: "device" as const, subjectRef: "machine:hub-test" };

  const JsonRpcCallSchema = z.object({
    id: z.number(),
    params: z.object({
      name: z.string(),
      arguments: z.record(z.string(), z.unknown()),
    }),
  });

  function fakeFetch(structured: Record<string, unknown>) {
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      const body = JsonRpcCallSchema.parse(
        JSON.parse(typeof init?.body === "string" ? init.body : ""),
      );
      calls.push({ tool: body.params.name, args: body.params.arguments });
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { structuredContent: structured } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    return { calls, fetchFn };
  }

  function gateway(fetchFn: typeof fetch) {
    return createNeoWriteApiGateway({
      url: "https://neo.example.ts.net:8443/mcp",
      token: "tok",
      subject: SUBJECT,
      fetchFn,
    });
  }

  it("parses a contract-conformant room_event_find hit (no duplicate field)", async () => {
    const { calls, fetchFn } = fakeFetch({
      status: "ok",
      event_id: "30000000-0000-4000-8000-0000000000e1",
      room_seq: 42,
      to: "paused",
      substate: null,
      correlation_id: CORRELATION,
      causation_id: "hub:control:grant-1",
    });
    const found = await gateway(fetchFn).findTransition(7, "hub-exec:e:control:pause:g");
    assert.deepEqual(found, {
      event_id: "30000000-0000-4000-8000-0000000000e1",
      room_seq: 42,
      duplicate: true,
      to: "paused",
      substate: null,
      correlation_id: CORRELATION,
      causation_id: "hub:control:grant-1",
    });
    assert.equal(calls[0]?.tool, "anvil.room_event_find");
    assert.equal(calls[0]?.args["idempotency_key"], "hub-exec:e:control:pause:g");
    assert.equal(calls[0]?.args["room_internal_id"], 7);
    assert.equal(calls[0]?.args["subject"], "machine:hub-test");
  });

  it("maps event_not_found to undefined", async () => {
    const { fetchFn } = fakeFetch({ status: "event_not_found" });
    assert.equal(await gateway(fetchFn).findTransition(7, "key"), undefined);
  });

  it("still rejects an append hit missing duplicate — append schema is not loosened", async () => {
    const { fetchFn } = fakeFetch({
      status: "ok",
      event_id: "30000000-0000-4000-8000-0000000000e1",
      room_seq: 42,
      to: "paused",
      substate: null,
      correlation_id: CORRELATION,
      causation_id: null,
    });
    await assert.rejects(
      gateway(fetchFn).appendTransition({
        room_id: ROOM,
        roomInternalId: 7,
        execution_id: "30000000-0000-4000-8000-0000000000e2",
        binding_id: "30000000-0000-4000-8000-0000000000e3",
        from: "running",
        to: "paused",
        substate: null,
        reason: "operator_pause",
        actor: CALLER,
        correlation_id: CORRELATION,
        causation_id: "hub:control:grant-1",
        idempotency_key: "hub-exec:e:control:pause:g",
        extra: {},
      }),
      DatabaseUnavailableError,
    );
  });
});

describe("ExecutionConvergence over a real authority", () => {
  let runtime: DatabaseRuntime;
  let directory: string;
  let roomInternal: number;
  let closedRoomInternal: number;
  let bindingAgentInternal: number;

  const records = new Map<string, AgentExecutionRecord>();
  const effects = {
    interrupts: [] as string[],
    cancels: [] as string[],
    resumes: [] as string[],
    retries: [] as { executionId: string; attemptId: string }[],
  };

  function executionRecord(id: string): AgentExecutionRecord {
    return {
      id,
      organizationId: "org-1",
      projectId: "project-1",
      machineId: null,
      status: "running",
      startedAt: new Date("2026-09-19T10:00:00.000Z"),
      completedAt: null,
      completedByAgentAt: null,
      deadlineAt: null,
      idleDeadlineAt: null,
      result: null,
      triggerContext: null,
      outputContext: null,
      reactionState: null,
      configurationRevisionId: "cfg-1",
      completionTokenHash: null,
      replyClaimedAt: null,
      replyClaimCount: 0,
      outputEmissions: {},
      outputDeliveryAttempts: {},
      launchIntent: null,
      daemonId: DAEMON,
      daemonAgentId: "daemon-agent-1",
      workflowStepRunId: null,
      hubAction: null,
      hubActionCompletedAt: null,
      hubActionReadyAt: null,
      hubActionAcknowledgements: {
        terminalAt: null,
        idleAt: null,
        finishExecutionCall: null,
      },
    };
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "hub-exec-convergence-"));
    const bundle = await embeddedDatabaseRuntime(join(directory, "database"));
    runtime = bundle.runtime;
    for (const statement of AUTHORITY_DDL.split(";")) {
      if (statement.trim().length > 0) await runtime.query(statement);
    }
    await runtime.query(`INSERT INTO anvil.agents (public_id) VALUES ($1)`, [BINDING_AGENT]);
    const agents = await runtime.query<{ id: number }>(
      `SELECT id FROM anvil.agents WHERE public_id = $1`,
      [BINDING_AGENT],
    );
    bindingAgentInternal = agents.rows[0]!.id;
    await runtime.query(
      `INSERT INTO anvil.rooms (public_id, status, correlation_id)
       VALUES ($1, 'active', $2), ($3, 'closed', $2)`,
      [ROOM, CORRELATION, ROOM_CLOSED],
    );
    const rooms = await runtime.query<{ id: number }>(
      `SELECT id FROM anvil.rooms WHERE public_id = $1`,
      [ROOM],
    );
    roomInternal = rooms.rows[0]!.id;
    const closed = await runtime.query<{ id: number }>(
      `SELECT id FROM anvil.rooms WHERE public_id = $1`,
      [ROOM_CLOSED],
    );
    closedRoomInternal = closed.rows[0]!.id;
    // The bound Hub subject holds room.execute on both rooms — the closed
    // room's grant exists so the non-active check, not the capability check,
    // is what rejects appends there.
    await runtime.query(
      `INSERT INTO anvil.capability_grants
         (subject_kind, subject_ref, capability, scope_kind, scope_room_id, granted_by)
       VALUES ('device', $1, 'room.execute', 'room', $2, 'operator:test'),
              ('device', $1, 'room.execute', 'room', $3, 'operator:test')`,
      [HUB_SUBJECT, roomInternal, closedRoomInternal],
    );
  }, 60_000);

  afterAll(async () => {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  });

  let counter = 0;
  /** Fresh execution id + Hub-local record + active authority binding. */
  async function bindExecution(options: { room?: number } = {}): Promise<string> {
    counter += 1;
    const executionId = `30000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
    records.set(executionId, executionRecord(executionId));
    await runtime.query(
      `INSERT INTO anvil.execution_bindings
         (agent_id, room_id, execution_id, correlation_id)
       VALUES ($1, $2, $3, $4)`,
      [bindingAgentInternal, options.room ?? roomInternal, executionId, CORRELATION],
    );
    return executionId;
  }

  function machineFor(subject: string = HUB_SUBJECT): ExecutionConvergence {
    const gateway = createSqlExecutionAuthorityGateway({
      handle: runtime,
      transact: (operation) => runtime.transaction(operation),
      subject: { kind: "device", subjectRef: subject },
    });
    return createExecutionConvergence({
      gateway,
      database: { findAgentExecutionById: async (id) => records.get(id) },
      interruptExecution: async (execution) => {
        effects.interrupts.push(execution.id);
      },
      cancelExecution: async (execution) => {
        effects.cancels.push(execution.id);
      },
      resumeExecution: async (execution) => {
        effects.resumes.push(execution.id);
        return true;
      },
      dispatchRetryAttempt: async (execution, attemptExecutionId) => {
        effects.retries.push({ executionId: execution.id, attemptId: attemptExecutionId });
      },
    });
  }

  const machine = () => machineFor();

  function agentUpdate(
    executionId: string,
    status: "running" | "idle" | "error" | "closed" | "initializing",
    timestamp: string,
  ): DaemonEvent {
    return {
      type: "agent_update",
      executionId,
      agentId: "daemon-agent-1",
      agent: { id: "daemon-agent-1", status },
      timestamp,
    };
  }

  function stream(
    executionId: string,
    event: DaemonAgentStreamEvent,
    timestamp: string,
  ): DaemonEvent {
    return {
      type: "agent_stream",
      executionId,
      agentId: "daemon-agent-1",
      event,
      timestamp,
    };
  }

  interface CommittedRow {
    room_seq: number;
    kind: string;
    producer: string;
    to: string;
    substate: string | null;
    reason: string;
    actor: string;
    grant_id: string | null;
    correlation_id: string;
    causation_id: string | null;
    idempotency_key: string;
    extra: Record<string, unknown>;
  }

  async function committedTransitions(executionId: string): Promise<CommittedRow[]> {
    const rows = await runtime.query<{
      room_seq: number | string;
      kind: string;
      producer: string;
      payload: Record<string, unknown>;
      correlation_id: string;
      causation_id: string | null;
      idempotency_key: string;
    }>(
      `SELECT room_seq, kind, producer, payload, correlation_id, causation_id,
              idempotency_key
       FROM anvil.room_events
       WHERE kind = 'execution.transition' AND payload->>'execution_id' = $1
       ORDER BY room_seq`,
      [executionId],
    );
    return rows.rows.map((row) => {
      const payload = row.payload;
      return {
        room_seq: Number(row.room_seq),
        kind: row.kind,
        producer: row.producer,
        to: String(payload["to"]),
        substate: typeof payload["substate"] === "string" ? payload["substate"] : null,
        reason: String(payload["reason"]),
        actor: String(payload["actor"]),
        grant_id: typeof payload["grant_id"] === "string" ? payload["grant_id"] : null,
        correlation_id: row.correlation_id,
        causation_id: row.causation_id,
        idempotency_key: row.idempotency_key,
        extra: payload,
      };
    });
  }

  it("folds the A3 sequence start → tool_wait → resume → complete with an unbroken causation chain", async () => {
    const executionId = await bindExecution();
    const convergence = machine();

    await convergence.observeDaemonEvent(
      executionId,
      DAEMON,
      agentUpdate(executionId, "running", "2026-09-19T12:00:01.000Z"),
    );
    await convergence.observeDaemonEvent(
      executionId,
      DAEMON,
      stream(
        executionId,
        { type: "permission_requested", provider: "devin", request: { tool: "shell" } },
        "2026-09-19T12:00:02.000Z",
      ),
    );
    await convergence.observeDaemonEvent(
      executionId,
      DAEMON,
      stream(
        executionId,
        {
          type: "permission_resolved",
          provider: "devin",
          requestId: "req-1",
          resolution: { approved: true },
        },
        "2026-09-19T12:00:03.000Z",
      ),
    );
    await convergence.observeTerminalIntent({
      executionId,
      to: "succeeded",
      causeRef: `paseo:${DAEMON}:${executionId}:finish`,
      occurredAt: new Date("2026-09-19T12:00:04.000Z"),
    });

    const rows = await committedTransitions(executionId);
    assert.deepEqual(
      rows.map((row) => [row.to, row.substate, row.reason]),
      [
        ["running", null, "agent_started"],
        ["running", "tool_wait", "tool_wait_entered"],
        ["running", null, "tool_wait_cleared"],
        ["succeeded", null, "completed_by_agent"],
      ],
    );
    for (const row of rows) {
      assert.equal(row.correlation_id, CORRELATION);
      assert.equal(row.producer, HUB_SUBJECT);
      assert.ok(row.causation_id !== null && row.causation_id.length > 0);
    }
    assert.equal(
      rows[0]?.causation_id,
      `paseo:${DAEMON}:${executionId}:agent_update:running:2026-09-19T12:00:01.000Z`,
    );
    assert.equal(rows[3]?.causation_id, `paseo:${DAEMON}:${executionId}:finish`);

    const description = await convergence.describeExecution(executionId);
    assert.equal(description.state, "succeeded");
    assert.equal(description.substate, null);
    assert.equal(description.room_id, ROOM);
    assert.equal(description.correlation_id, CORRELATION);
    assert.equal(description.last_transition?.room_seq, rows[3]?.room_seq);
  });

  it("never infers completion from agent idleness alone", async () => {
    const executionId = await bindExecution();
    const convergence = machine();
    await convergence.observeDaemonEvent(
      executionId,
      DAEMON,
      agentUpdate(executionId, "running", "2026-09-19T12:01:00.000Z"),
    );
    await convergence.observeDaemonEvent(
      executionId,
      DAEMON,
      agentUpdate(executionId, "idle", "2026-09-19T12:01:01.000Z"),
    );
    const rows = await committedTransitions(executionId);
    assert.deepEqual(
      rows.map((row) => row.to),
      ["running"],
    );
    assert.equal((await convergence.describeExecution(executionId)).state, "running");
  });

  it("applies the orphan rule: agent error/closed fails even out of a held state", async () => {
    const executionId = await bindExecution();
    const convergence = machine();
    await convergence.observeDaemonEvent(
      executionId,
      DAEMON,
      agentUpdate(executionId, "running", "2026-09-19T12:02:00.000Z"),
    );
    const grant = await convergence.mintGrant({
      executionId,
      action: "pause",
      principal: CALLER,
      ttlSeconds: 300,
    });
    await convergence.performAction({
      executionId,
      action: "pause",
      grantId: grant.grant_id,
      principal: CALLER,
    });
    // The daemon reports the agent died underneath the pause.
    await convergence.observeDaemonEvent(
      executionId,
      DAEMON,
      agentUpdate(executionId, "closed", "2026-09-19T12:02:05.000Z"),
    );
    const rows = await committedTransitions(executionId);
    assert.deepEqual(
      rows.map((row) => [row.to, row.reason]),
      [
        ["running", "agent_started"],
        ["paused", "operator_pause"],
        ["failed", "agent_interrupted"],
      ],
    );
  });

  it("does not treat turn_canceled as a cancel", async () => {
    const executionId = await bindExecution();
    const convergence = machine();
    await convergence.observeDaemonEvent(
      executionId,
      DAEMON,
      agentUpdate(executionId, "running", "2026-09-19T12:03:00.000Z"),
    );
    await convergence.observeDaemonEvent(
      executionId,
      DAEMON,
      stream(
        executionId,
        { type: "turn_canceled", provider: "devin", reason: "interrupt" },
        "2026-09-19T12:03:01.000Z",
      ),
    );
    const rows = await committedTransitions(executionId);
    assert.deepEqual(
      rows.map((row) => row.to),
      ["running"],
    );
  });

  it("keeps unbound executions Hub-local and terminal intents idempotent", async () => {
    const unbound = "30000000-0000-4000-8000-0000000000ff";
    const convergence = machine();
    // Unknown + unbound: no throw, no rows.
    await convergence.observeDaemonEvent(
      unbound,
      DAEMON,
      agentUpdate(unbound, "running", "2026-09-19T12:04:00.000Z"),
    );
    await convergence.observeTerminalIntent({
      executionId: unbound,
      to: "failed",
      hubReason: "idle_timeout",
      causeRef: "cause-1",
    });
    assert.deepEqual(await committedTransitions(unbound), []);

    const executionId = await bindExecution();
    await convergence.observeDaemonEvent(
      executionId,
      DAEMON,
      agentUpdate(executionId, "running", "2026-09-19T12:04:01.000Z"),
    );
    await convergence.observeTerminalIntent({
      executionId,
      to: "failed",
      hubReason: "idle_timeout",
      causeRef: `paseo:${DAEMON}:${executionId}:timeout`,
    });
    // Second terminal intent is a no-op — authority already shows terminal.
    await convergence.observeTerminalIntent({
      executionId,
      to: "succeeded",
      causeRef: `paseo:${DAEMON}:${executionId}:finish`,
    });
    const rows = await committedTransitions(executionId);
    assert.deepEqual(
      rows.map((row) => [row.to, row.reason]),
      [
        ["running", "agent_started"],
        ["failed", "timed_out"],
      ],
    );
  });

  it("I4: mint → pause stamps the granting principal and hub:control causation, then applies the effect", async () => {
    const executionId = await bindExecution();
    const convergence = machine();
    await convergence.observeDaemonEvent(
      executionId,
      DAEMON,
      agentUpdate(executionId, "running", "2026-09-19T12:05:00.000Z"),
    );
    const grant = await convergence.mintGrant({
      executionId,
      action: "pause",
      principal: CALLER,
      ttlSeconds: 300,
    });
    assert.equal(grant.action, "pause");
    assert.equal(grant.principal, CALLER);

    const before = effects.interrupts.length;
    const outcome = await convergence.performAction({
      executionId,
      action: "pause",
      grantId: grant.grant_id,
      principal: CALLER,
    });
    assert.equal(outcome.state, "paused");
    assert.equal(outcome.duplicate, false);
    assert.equal(outcome.effect_applied, true);
    assert.equal(effects.interrupts.length, before + 1);

    const rows = await committedTransitions(executionId);
    const pause = rows.at(-1)!;
    assert.equal(pause.reason, "operator_pause");
    assert.equal(pause.causation_id, `hub:control:${grant.grant_id}`);
    assert.equal(pause.actor, CALLER);
    assert.equal(pause.grant_id, grant.grant_id);
    assert.equal(pause.producer, HUB_SUBJECT);
  });

  it("I4: replaying the same grant returns the committed winner without re-applying the effect", async () => {
    const executionId = await bindExecution();
    const convergence = machine();
    await convergence.observeDaemonEvent(
      executionId,
      DAEMON,
      agentUpdate(executionId, "running", "2026-09-19T12:06:00.000Z"),
    );
    const grant = await convergence.mintGrant({
      executionId,
      action: "pause",
      principal: CALLER,
      ttlSeconds: 300,
    });
    const first = await convergence.performAction({
      executionId,
      action: "pause",
      grantId: grant.grant_id,
      principal: CALLER,
    });
    const second = await convergence.performAction({
      executionId,
      action: "pause",
      grantId: grant.grant_id,
      principal: CALLER,
    });
    assert.equal(second.duplicate, true);
    assert.equal(second.event_id, first.event_id);
    assert.equal(second.room_seq, first.room_seq);
    assert.equal(effects.interrupts.filter((id) => id === executionId).length, 1);
    assert.equal(
      (await committedTransitions(executionId)).filter((row) => row.to === "paused").length,
      1,
    );
  });

  it("I4: expired, revoked, wrong-action, cross-principal, and wrong-room grants all deny", async () => {
    const executionId = await bindExecution();
    const convergence = machine();
    await convergence.observeDaemonEvent(
      executionId,
      DAEMON,
      agentUpdate(executionId, "running", "2026-09-19T12:07:00.000Z"),
    );

    const expired = await convergence.mintGrant({
      executionId,
      action: "pause",
      principal: CALLER,
      ttlSeconds: -60,
    });
    await assert.rejects(
      convergence.performAction({
        executionId,
        action: "pause",
        grantId: expired.grant_id,
        principal: CALLER,
      }),
      CapabilityDeniedError,
    );

    const revoked = await convergence.mintGrant({
      executionId,
      action: "pause",
      principal: CALLER,
      ttlSeconds: 300,
    });
    await runtime.query(
      `UPDATE anvil.capability_grants SET revoked_at = now() WHERE public_id = $1`,
      [revoked.grant_id],
    );
    await assert.rejects(
      convergence.performAction({
        executionId,
        action: "pause",
        grantId: revoked.grant_id,
        principal: CALLER,
      }),
      CapabilityDeniedError,
    );

    const wrongAction = await convergence.mintGrant({
      executionId,
      action: "cancel",
      principal: CALLER,
      ttlSeconds: 300,
    });
    await assert.rejects(
      convergence.performAction({
        executionId,
        action: "pause",
        grantId: wrongAction.grant_id,
        principal: CALLER,
      }),
      CapabilityDeniedError,
    );

    const crossPrincipal = await convergence.mintGrant({
      executionId,
      action: "pause",
      principal: CALLER,
      ttlSeconds: 300,
    });
    await assert.rejects(
      convergence.performAction({
        executionId,
        action: "pause",
        grantId: crossPrincipal.grant_id,
        principal: OTHER_CALLER,
      }),
      CapabilityDeniedError,
    );

    // Room-scoped grant for a different room → scope mismatch.
    await runtime.query(
      `INSERT INTO anvil.capability_grants
         (public_id, subject_kind, subject_ref, capability, scope_kind,
          scope_room_id, granted_by, correlation_id)
       VALUES ($1, 'device', $2, 'execution.pause', 'room', $3, $4, $5)`,
      [
        "40000000-0000-4000-8000-000000000001",
        CALLER,
        closedRoomInternal,
        HUB_SUBJECT,
        CORRELATION,
      ],
    );
    await assert.rejects(
      convergence.performAction({
        executionId,
        action: "pause",
        grantId: "40000000-0000-4000-8000-000000000001",
        principal: CALLER,
      }),
      CapabilityDeniedError,
    );

    // Grant minted on the wrong correlation → correlation mismatch.
    await runtime.query(
      `INSERT INTO anvil.capability_grants
         (public_id, subject_kind, subject_ref, capability, scope_kind,
          scope_room_id, granted_by, correlation_id)
       VALUES ($1, 'device', $2, 'execution.pause', 'room', $3, $4, $5)`,
      [
        "40000000-0000-4000-8000-000000000002",
        CALLER,
        roomInternal,
        HUB_SUBJECT,
        "50000000-0000-4000-8000-000000000099",
      ],
    );
    await assert.rejects(
      convergence.performAction({
        executionId,
        action: "pause",
        grantId: "40000000-0000-4000-8000-000000000002",
        principal: CALLER,
      }),
      CapabilityDeniedError,
    );

    await assert.rejects(
      convergence.performAction({
        executionId,
        action: "pause",
        grantId: "40000000-0000-4000-8000-0000000000ff",
        principal: CALLER,
      }),
      CapabilityDeniedError,
    );
  });

  it("I4: illegal actions fail with invalid_state; unknown/unbound executions are distinct", async () => {
    const executionId = await bindExecution();
    const convergence = machine();
    // Still queued — pause is not legal.
    const grant = await convergence
      .mintGrant({
        executionId,
        action: "pause",
        principal: CALLER,
        ttlSeconds: 300,
      })
      .catch((error: unknown) => error);
    // mintGrant itself enforces legality — pause on queued throws.
    assert.ok(grant instanceof InvalidExecutionStateError);

    await assert.rejects(
      convergence.performAction({
        executionId: "30000000-0000-4000-8000-0000000000ee",
        action: "cancel",
        grantId: "40000000-0000-4000-8000-0000000000ff",
        principal: CALLER,
      }),
      ExecutionNotFoundError,
    );

    const knownUnbound = "30000000-0000-4000-8000-0000000000dd";
    records.set(knownUnbound, executionRecord(knownUnbound));
    await assert.rejects(convergence.describeExecution(knownUnbound), ExecutionNotBoundError);
    await assert.rejects(
      convergence.performAction({
        executionId: knownUnbound,
        action: "cancel",
        grantId: "40000000-0000-4000-8000-0000000000ff",
        principal: CALLER,
      }),
      ExecutionNotBoundError,
    );
  });

  it("I4: pause → resume → cancel walks the held-state chain with real effects", async () => {
    const executionId = await bindExecution();
    const convergence = machine();
    await convergence.observeDaemonEvent(
      executionId,
      DAEMON,
      agentUpdate(executionId, "running", "2026-09-19T12:08:00.000Z"),
    );
    const mint = (action: "pause" | "resume" | "cancel") =>
      convergence.mintGrant({
        executionId,
        action,
        principal: CALLER,
        ttlSeconds: 300,
      });
    const pauseGrant = await mint("pause");
    await convergence.performAction({
      executionId,
      action: "pause",
      grantId: pauseGrant.grant_id,
      principal: CALLER,
    });

    const resumeGrant = await mint("resume");
    const resumed = await convergence.performAction({
      executionId,
      action: "resume",
      grantId: resumeGrant.grant_id,
      principal: CALLER,
    });
    assert.equal(resumed.state, "running");
    assert.equal(resumed.effect_applied, true);
    assert.ok(effects.resumes.includes(executionId));

    const cancelGrant = await mint("cancel");
    const cancelled = await convergence.performAction({
      executionId,
      action: "cancel",
      grantId: cancelGrant.grant_id,
      principal: CALLER,
    });
    assert.equal(cancelled.state, "cancelled");
    assert.ok(effects.cancels.includes(executionId));

    // Terminal is absorbing: no further control, no further signals.
    const lateGrant = await convergence
      .mintGrant({ executionId, action: "cancel", principal: CALLER, ttlSeconds: 300 })
      .catch((error: unknown) => error);
    assert.ok(lateGrant instanceof InvalidExecutionStateError);
    await convergence.observeDaemonEvent(
      executionId,
      DAEMON,
      agentUpdate(executionId, "running", "2026-09-19T12:08:30.000Z"),
    );
    const rows = await committedTransitions(executionId);
    assert.deepEqual(
      rows.map((row) => row.to),
      ["running", "paused", "running", "cancelled"],
    );
  });

  it("I4: retry commits a marker with deterministic lineage before dispatch, and replays safely", async () => {
    const executionId = await bindExecution();
    const convergence = machine();
    await convergence.observeDaemonEvent(
      executionId,
      DAEMON,
      agentUpdate(executionId, "running", "2026-09-19T12:09:00.000Z"),
    );
    await convergence.observeDaemonEvent(
      executionId,
      DAEMON,
      agentUpdate(executionId, "error", "2026-09-19T12:09:05.000Z"),
    );

    const grant = await convergence.mintGrant({
      executionId,
      action: "retry",
      principal: CALLER,
      ttlSeconds: 300,
    });
    const first = await convergence.performAction({
      executionId,
      action: "retry",
      grantId: grant.grant_id,
      principal: CALLER,
    });
    assert.equal(first.duplicate, false);
    assert.ok(first.retry_execution_id !== undefined);
    assert.equal(first.effect_applied, true);
    assert.deepEqual(effects.retries.at(-1), {
      executionId,
      attemptId: first.retry_execution_id,
    });

    const second = await convergence.performAction({
      executionId,
      action: "retry",
      grantId: grant.grant_id,
      principal: CALLER,
    });
    assert.equal(second.duplicate, true);
    assert.equal(second.retry_execution_id, first.retry_execution_id);
    assert.equal(effects.retries.filter((r) => r.executionId === executionId).length, 1);

    const rows = await committedTransitions(executionId);
    const marker = rows.at(-1)!;
    assert.equal(marker.reason, "operator_retry");
    assert.equal(marker.extra["retry_of"], executionId);
    assert.equal(marker.extra["retry_execution_id"], first.retry_execution_id);
    assert.equal(marker.causation_id, `hub:control:${grant.grant_id}`);
  });

  it("I4: acknowledge is a marker-only transition that preserves state", async () => {
    const executionId = await bindExecution();
    const convergence = machine();
    await convergence.observeDaemonEvent(
      executionId,
      DAEMON,
      agentUpdate(executionId, "running", "2026-09-19T12:10:00.000Z"),
    );
    const grant = await convergence.mintGrant({
      executionId,
      action: "acknowledge",
      principal: CALLER,
      ttlSeconds: 300,
    });
    const outcome = await convergence.performAction({
      executionId,
      action: "acknowledge",
      grantId: grant.grant_id,
      principal: CALLER,
      requestId: "req-ack-1",
    });
    assert.equal(outcome.state, "running");
    const rows = await committedTransitions(executionId);
    const marker = rows.at(-1)!;
    assert.equal(marker.reason, "operator_acknowledge");
    assert.equal(marker.extra["acknowledged"], true);
  });

  it("I4: tool_wait resume is marker-only — the agent still owns the turn", async () => {
    const executionId = await bindExecution();
    const convergence = machine();
    await convergence.observeDaemonEvent(
      executionId,
      DAEMON,
      agentUpdate(executionId, "running", "2026-09-19T12:11:00.000Z"),
    );
    await convergence.observeDaemonEvent(
      executionId,
      DAEMON,
      stream(
        executionId,
        { type: "permission_requested", provider: "devin", request: {} },
        "2026-09-19T12:11:01.000Z",
      ),
    );
    const before = effects.resumes.length;
    const grant = await convergence.mintGrant({
      executionId,
      action: "resume",
      principal: CALLER,
      ttlSeconds: 300,
    });
    const outcome = await convergence.performAction({
      executionId,
      action: "resume",
      grantId: grant.grant_id,
      principal: CALLER,
    });
    assert.equal(outcome.state, "running");
    assert.equal(outcome.substate, "tool_wait");
    assert.equal(effects.resumes.length, before);
  });

  it("fails closed without a room.execute grant and on a non-active room", async () => {
    const executionId = await bindExecution();
    const denied = machineFor("machine:no-grant");
    await assert.rejects(
      denied.observeTerminalIntent({
        executionId,
        to: "failed",
        hubReason: "idle_timeout",
        causeRef: "cause-denied",
      }),
      RoomCapabilityDeniedError,
    );

    const closedExecution = await bindExecution({ room: closedRoomInternal });
    const convergence = machine();
    await assert.rejects(
      convergence.observeTerminalIntent({
        executionId: closedExecution,
        to: "succeeded",
        causeRef: "cause-closed",
      }),
      RoomNotActiveError,
    );
  });
});
