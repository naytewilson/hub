import type { Pool } from "pg";
import type { QueryResultRow } from "pg";
import { toDatabaseError } from "../db/errors.js";
import type { QueryHandle, QueryResult, QueryRow } from "../db/runtime/index.js";
import {
  anvilSubjectLabel,
  type AnvilRoomSubject,
  type RoomStatus,
} from "../room-projection/contract.js";
import { RoomCapabilityDeniedError, RoomNotFoundError } from "../room-projection/reader.js";
import {
  EXECUTION_STATES,
  EXECUTION_SUBSTATES,
  EXECUTION_TRANSITION_KIND,
  RoomNotActiveError,
  type ExecutionState,
  type ExecutionSubstate,
} from "./contract.js";

/**
 * Hub-side write seam into ANVIL execution authority (I3/I4). Semantic, not
 * raw-SQL-shaped: the direct-Postgres implementation here is for
 * authority-adjacent deployments (Hub co-located with `anvil_core`), and the
 * Neo-side write service transport in `write-api.ts` implements the same
 * surface for the tailnet topology. Hub production code never writes the
 * read-only projection pool — that pool is `default_transaction_read_only=on`.
 *
 * Every method mirrors the authority semantics in i1's roomdb.go exactly:
 * - `room_seq` is allocated inside the committing transaction by
 *   `UPDATE anvil.rooms SET next_seq = next_seq + 1 … RETURNING next_seq - 1`;
 *   the room row lock serializes writers and gaps are legal.
 * - Appends are idempotent on `UNIQUE(room_id, idempotency_key)`; a duplicate
 *   delivery returns the committed winner with `duplicate: true`.
 * - `producer` is server-stamped from the bound subject — never caller input.
 * - `correlation_id` falls back to the Room lineage root when the caller
 *   supplies none, matching roomdb's ZeroUUID fallback.
 *
 * The writer additionally enforces the authority gate Hub-side for the SQL
 * transport: the bound subject must hold a durable `room.execute` grant on the
 * target room (C2 `requiredCapability(execution)`), or the call fails closed
 * with {@link RoomCapabilityDeniedError}. For the Neo transport the same check
 * is enforced service-side.
 */
export const EXECUTION_WRITE_CAPABILITY = "room.execute" as const;

/** An `execution_bindings` row joined to its owning Room — authority truth. */
export interface ResolvedExecutionBinding {
  /** `anvil.execution_bindings.execution_id` — the durable execution identity. */
  execution_id: string;
  /** `anvil.execution_bindings.public_id`. */
  binding_id: string;
  binding_status: "active" | "replaced" | "released";
  /** `anvil.rooms.public_id`. */
  room_id: string;
  /**
   * Internal `anvil.rooms.id` (BIGINT) — authority-internal join key needed by
   * appendTransition/mintGrant. Exposed only so the caller can hand it back;
   * it is never served on the wire.
   */
  room_internal_id: number;
  room_status: RoomStatus;
  /** Binding correlation when set, else the Room lineage root. */
  correlation_id: string;
  /** Latest committed `execution.transition` for this execution, if any. */
  last_transition: {
    state: ExecutionState;
    substate: ExecutionSubstate | null;
    room_seq: number;
    event_id: string;
    occurred_at: string | null;
    causation_id: string | null;
  } | null;
}

/** One committed `anvil.room_events` row as the writer observes it. */
export interface CommittedTransition {
  event_id: string;
  room_seq: number;
  /** True when an existing row with the same idempotency key was returned. */
  duplicate: boolean;
  /** Winner's committed target state/substate — the machine adopts it. */
  to: string;
  substate: string | null;
  correlation_id: string;
  causation_id: string | null;
}

export interface AppendTransitionInput {
  /** Internal room row id — from `ResolvedExecutionBinding.room_internal_id`. */
  roomInternalId: number;
  room_id: string;
  execution_id: string;
  binding_id: string;
  correlation_id: string;
  from: ExecutionState;
  to: ExecutionState;
  substate: ExecutionSubstate | null;
  reason: string;
  causation_id: string;
  idempotency_key: string;
  /** Granting principal for control actions; the bound subject otherwise. */
  actor: string;
  grant_id?: string;
  /** Extra payload fields (acknowledged, retry_execution_id, retry_of, …). */
  extra?: Record<string, unknown>;
  occurred_at?: string;
}

/** An `anvil.capability_grants` row as the control plane observes it. */
export interface CapabilityGrantRecord {
  /** `capability_grants.public_id`. */
  grant_id: string;
  subject_kind: "agent" | "device" | "user";
  /** Producer-form principal, e.g. `device:hub-credential:<id>` or `agent:<uuid>`. */
  subject_ref: string;
  capability: string;
  scope_kind: "global" | "room";
  /** `anvil.rooms.public_id` of the room scope, null for global grants. */
  scope_room_id: string | null;
  correlation_id: string | null;
  granted_by: string;
  issued_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface MintGrantInput {
  resolved: ResolvedExecutionBinding;
  roomInternalId: number;
  action: string;
  principal: string;
  expires_at: string;
}

export interface ExecutionAuthorityGateway {
  /** Producer-form label the writer stamps (bound subject), e.g. `machine:x`. */
  readonly producer: string;
  /**
   * Resolve the ACTIVE `execution_bindings` row for an execution id, joined to
   * its Room and annotated with the latest committed transition for state
   * rehydration. Undefined when no active binding exists.
   */
  resolveExecution(executionId: string): Promise<ResolvedExecutionBinding | undefined>;
  /**
   * Look up a committed transition by idempotency key. Control replay
   * detection: a repeated action must return the committed winner even when
   * the execution's state has since moved on (so it precedes legality checks).
   */
  findTransition(
    roomInternalId: number,
    idempotencyKey: string,
  ): Promise<CommittedTransition | undefined>;
  /** Idempotent authority append; assigns room_seq under the room row lock. */
  appendTransition(input: AppendTransitionInput): Promise<CommittedTransition>;
  /** Insert an authority-side grant row; `granted_by` is server-stamped. */
  mintGrant(input: MintGrantInput): Promise<CapabilityGrantRecord>;
  findGrant(grantId: string): Promise<CapabilityGrantRecord | undefined>;
}

interface BindingRow extends QueryRow {
  binding_id: unknown;
  binding_status: unknown;
  room_pk: unknown;
  room_id: unknown;
  room_status: unknown;
  binding_correlation: unknown;
  room_correlation: unknown;
}

interface LastTransitionRow extends QueryRow {
  event_id: unknown;
  room_seq: unknown;
  to_state: unknown;
  substate: unknown;
  occurred_at: unknown;
  causation_id: unknown;
}

interface EventRow extends QueryRow {
  event_id: unknown;
  room_seq: unknown;
  correlation_id: unknown;
  causation_id: unknown;
  payload: unknown;
}

interface GrantRow extends QueryRow {
  grant_id: unknown;
  subject_kind: unknown;
  subject_ref: unknown;
  subject_agent_public_id: unknown;
  capability: unknown;
  scope_kind: unknown;
  scope_room_public_id: unknown;
  granted_by: unknown;
  correlation_id: unknown;
  expires_at: unknown;
  revoked_at: unknown;
  created_at: unknown;
}

interface IdRow extends QueryRow {
  id: unknown;
}

/** Runs a function inside a real transaction (BEGIN/COMMIT/ROLLBACK). */
export interface SqlTransactionRunner {
  transaction<T>(operation: (handle: QueryHandle) => Promise<T>): Promise<T>;
}

/**
 * Direct-Postgres implementation of {@link ExecutionAuthorityGateway}. The
 * handle must be writable (a dedicated writer pool — never the read-only
 * projection pool). `transact` supplies the committing transaction; appends
 * allocate `room_seq` under the room row lock inside it.
 */
export function createSqlExecutionAuthorityGateway(options: {
  handle: QueryHandle;
  transact: SqlTransactionRunner["transaction"];
  subject: AnvilRoomSubject;
}): ExecutionAuthorityGateway {
  const { handle, transact, subject } = options;
  const producer = anvilSubjectLabel(subject);

  async function query<Row extends QueryRow>(
    text: string,
    values: readonly unknown[],
    on: QueryHandle = handle,
  ): Promise<Row[]> {
    try {
      const result = await on.query<Row>(text, values);
      return result.rows;
    } catch (error) {
      throw toDatabaseError(error);
    }
  }

  /** C2 `actorHolds` mirrored for `room.execute` — same predicate as the reader. */
  async function subjectHoldsExecute(
    roomInternalId: number,
    on: QueryHandle = handle,
  ): Promise<boolean> {
    if (subject.kind === "agent") {
      const agents = await query<IdRow>(
        `SELECT id FROM anvil.agents WHERE public_id = $1`,
        [subject.publicId],
        on,
      );
      const agent = agents[0];
      if (agent === undefined) return false;
      const rows = await query(
        `SELECT 1 FROM anvil.capability_grants
         WHERE subject_kind = 'agent'
           AND subject_agent_id = $1
           AND capability = $2
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > now())
           AND (scope_kind = 'global' OR scope_room_id = $3)
         LIMIT 1`,
        [toInt(agent.id), EXECUTION_WRITE_CAPABILITY, roomInternalId],
        on,
      );
      return rows.length > 0;
    }
    const rows = await query(
      `SELECT 1 FROM anvil.capability_grants
       WHERE subject_kind = $1
         AND subject_ref = $2
         AND capability = $3
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())
         AND (scope_kind = 'global' OR scope_room_id = $4)
       LIMIT 1`,
      [subject.kind, subject.subjectRef, EXECUTION_WRITE_CAPABILITY, roomInternalId],
      on,
    );
    return rows.length > 0;
  }

  async function producerAgentId(on: QueryHandle): Promise<number | null> {
    if (subject.kind !== "agent") return null;
    const rows = await query<IdRow>(
      `SELECT id FROM anvil.agents WHERE public_id = $1`,
      [subject.publicId],
      on,
    );
    return rows[0] === undefined ? null : toInt(rows[0].id);
  }

  return {
    producer,

    async resolveExecution(executionId) {
      const bindings = await query<BindingRow>(
        `SELECT b.public_id AS binding_id, b.status AS binding_status,
                r.id AS room_pk, r.public_id AS room_id, r.status AS room_status,
                b.correlation_id AS binding_correlation,
                r.correlation_id AS room_correlation
         FROM anvil.execution_bindings b
         JOIN anvil.rooms r ON r.id = b.room_id
         WHERE b.execution_id = $1 AND b.status = 'active'
         ORDER BY b.id DESC
         LIMIT 1`,
        [executionId],
      );
      const binding = bindings[0];
      if (binding === undefined) return undefined;
      const roomInternalId = toInt(binding.room_pk);
      const transitions = await query<LastTransitionRow>(
        `SELECT public_id AS event_id, room_seq,
                payload->>'to' AS to_state, payload->>'substate' AS substate,
                occurred_at, causation_id
         FROM anvil.room_events
         WHERE room_id = $1 AND kind = $2 AND payload->>'execution_id' = $3
         ORDER BY room_seq DESC
         LIMIT 1`,
        [roomInternalId, EXECUTION_TRANSITION_KIND, executionId],
      );
      const last = transitions[0];
      return {
        execution_id: executionId,
        binding_id: toText(binding.binding_id),
        binding_status: toBindingStatus(binding.binding_status),
        room_id: toText(binding.room_id),
        room_status: toRoomStatus(binding.room_status),
        correlation_id:
          binding.binding_correlation === null || binding.binding_correlation === undefined
            ? toText(binding.room_correlation)
            : toText(binding.binding_correlation),
        last_transition:
          last === undefined
            ? null
            : {
                state: toExecutionState(last.to_state),
                substate: toExecutionSubstate(last.substate),
                room_seq: toInt(last.room_seq),
                event_id: toText(last.event_id),
                occurred_at: toNullableTimestamp(last.occurred_at),
                causation_id: toNullableText(last.causation_id),
              },
        room_internal_id: roomInternalId,
      };
    },

    async findTransition(roomInternalId, idempotencyKey) {
      const rows = await query<EventRow>(
        `SELECT public_id AS event_id, room_seq, correlation_id, causation_id, payload
         FROM anvil.room_events
         WHERE room_id = $1 AND idempotency_key = $2`,
        [roomInternalId, idempotencyKey],
      );
      const row = rows[0];
      return row === undefined ? undefined : projectCommitted(row);
    },

    async appendTransition(input) {
      return transact(async (tx) => {
        if (!(await subjectHoldsExecute(input.roomInternalId, tx))) {
          throw new RoomCapabilityDeniedError(EXECUTION_WRITE_CAPABILITY, producer, input.room_id);
        }
        const rooms = await query<{ status: unknown }>(
          `SELECT status FROM anvil.rooms WHERE id = $1 FOR UPDATE`,
          [input.roomInternalId],
          tx,
        );
        const room = rooms[0];
        if (room === undefined) throw new RoomNotFoundError(input.room_id);
        const status = toText(room.status);
        if (status !== "active") throw new RoomNotActiveError(input.room_id, status);

        const seqRows = await query<{ seq: unknown }>(
          `UPDATE anvil.rooms SET next_seq = next_seq + 1 WHERE id = $1
           RETURNING next_seq - 1 AS seq`,
          [input.roomInternalId],
          tx,
        );
        const seq = seqRows[0];
        if (seq === undefined) throw new RoomNotFoundError(input.room_id);
        const roomSeq = toInt(seq.seq);

        const occurredAt = input.occurred_at ?? new Date().toISOString();
        const link = {
          schema: "anvil.correlation.v1",
          correlation_id: input.correlation_id,
          causation_id: input.causation_id,
          producer,
          occurred_at: occurredAt,
          idempotency_key: input.idempotency_key,
          campaign_id: null,
          task_ref: null,
        };
        const payload = {
          execution_id: input.execution_id,
          execution_binding_id: input.binding_id,
          from: input.from,
          to: input.to,
          substate: input.substate,
          reason: input.reason,
          actor: input.actor,
          ...(input.grant_id === undefined ? {} : { grant_id: input.grant_id }),
          ...input.extra,
        };
        const agentId = await producerAgentId(tx);

        const insertColumns = `public_id AS event_id, room_seq, correlation_id, causation_id, payload`;
        const inserted = await query<EventRow>(
          `INSERT INTO anvil.room_events
             (room_id, room_seq, kind, producer, producer_agent_id, payload, link,
              correlation_id, causation_id, task_ref, campaign_id, idempotency_key,
              occurred_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,NULL,$10,$11)
           ON CONFLICT (room_id, idempotency_key) DO NOTHING
           RETURNING ${insertColumns}`,
          [
            input.roomInternalId,
            roomSeq,
            EXECUTION_TRANSITION_KIND,
            producer,
            agentId,
            JSON.stringify(payload),
            JSON.stringify(link),
            input.correlation_id,
            input.causation_id,
            input.idempotency_key,
            occurredAt,
          ],
          tx,
        );
        let row = inserted[0];
        let duplicate = false;
        if (row === undefined) {
          const winners = await query<EventRow>(
            `SELECT ${insertColumns}
             FROM anvil.room_events
             WHERE room_id = $1 AND idempotency_key = $2`,
            [input.roomInternalId, input.idempotency_key],
            tx,
          );
          row = winners[0];
          if (row === undefined) {
            // The conflicting transaction rolled back between ON CONFLICT's
            // wait and this SELECT — surface as a fault, never fabricate.
            throw new Error(
              `idempotent insert conflicted but no committed row is visible for key ${input.idempotency_key}`,
            );
          }
          duplicate = true;
        }
        const committed = projectCommitted(row, input.to);
        committed.duplicate = duplicate;
        return committed;
      });
    },

    async mintGrant(input) {
      if (!(await subjectHoldsExecute(input.roomInternalId))) {
        throw new RoomCapabilityDeniedError(
          EXECUTION_WRITE_CAPABILITY,
          producer,
          input.resolved.room_id,
        );
      }
      // The grant subject is the CALLER principal (device:hub-credential:<id>),
      // never the bound Hub subject — Hub mints for the authenticated caller.
      const rows = await query<GrantRow>(
        `INSERT INTO anvil.capability_grants
           (subject_kind, subject_agent_id, subject_ref, capability,
            scope_kind, scope_room_id, granted_by, correlation_id, expires_at)
         VALUES ($7, NULL, $1, $2, 'room', $3, $4, $5, $6)
         RETURNING public_id AS grant_id, subject_kind, subject_ref,
                   NULL AS subject_agent_public_id, capability, scope_kind,
                   (SELECT public_id FROM anvil.rooms WHERE id = $3) AS scope_room_public_id,
                   granted_by, correlation_id, expires_at, revoked_at, created_at`,
        [
          input.principal,
          `execution.${input.action}`,
          input.roomInternalId,
          producer,
          input.resolved.correlation_id,
          input.expires_at,
          grantSubjectKind(input.principal),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw new Error("capability grant insert returned no row");
      return projectGrant(row);
    },

    async findGrant(grantId) {
      const rows = await query<GrantRow>(
        `SELECT g.public_id AS grant_id, g.subject_kind,
                COALESCE(g.subject_ref, 'agent:' || a.public_id::text) AS subject_ref,
                a.public_id AS subject_agent_public_id, g.capability, g.scope_kind,
                r.public_id AS scope_room_public_id, g.granted_by, g.correlation_id,
                g.expires_at, g.revoked_at, g.created_at
         FROM anvil.capability_grants g
         LEFT JOIN anvil.agents a ON a.id = g.subject_agent_id
         LEFT JOIN anvil.rooms r ON r.id = g.scope_room_id
         WHERE g.public_id = $1`,
        [grantId],
      );
      const row = rows[0];
      return row === undefined ? undefined : projectGrant(row);
    },
  };
}

function projectCommitted(row: EventRow, fallbackTo?: string): CommittedTransition {
  const payload = isJsonObject(row.payload) ? row.payload : {};
  return {
    event_id: toText(row.event_id),
    room_seq: toInt(row.room_seq),
    duplicate: false,
    to: typeof payload["to"] === "string" ? payload["to"] : (fallbackTo ?? ""),
    substate: typeof payload["substate"] === "string" ? payload["substate"] : null,
    correlation_id: toText(row.correlation_id),
    causation_id: toNullableText(row.causation_id),
  };
}

function projectGrant(row: GrantRow): CapabilityGrantRecord {
  return {
    grant_id: toText(row.grant_id),
    subject_kind: toGrantSubjectKind(row.subject_kind),
    subject_ref: toText(row.subject_ref),
    capability: toText(row.capability),
    scope_kind: row.scope_kind === "room" ? "room" : "global",
    scope_room_id: toNullableText(row.scope_room_public_id),
    correlation_id: toNullableText(row.correlation_id),
    granted_by: toText(row.granted_by),
    issued_at: toTimestamp(row.created_at),
    expires_at: toNullableTimestamp(row.expires_at),
    revoked_at: toNullableTimestamp(row.revoked_at),
  };
}

/**
 * Wraps a `pg.Pool` as QueryHandle + transaction runner for the writer pool.
 * The pool must be a WRITABLE authority-adjacent pool — created with
 * `createExecutionWriterPool` in index.ts, never the read-only projection pool.
 */
export function createPoolWriteHandle(
  pool: Pick<Pool, "query" | "connect">,
): QueryHandle & SqlTransactionRunner {
  return {
    async query<Row extends QueryRow = QueryRow>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<Row>> {
      const result = await pool.query<Row & QueryResultRow>(sql, [...params]);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
    async transaction<T>(operation: (handle: QueryHandle) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const handle: QueryHandle = {
          async query<Row extends QueryRow = QueryRow>(
            sql: string,
            params: readonly unknown[] = [],
          ): Promise<QueryResult<Row>> {
            const result = await client.query<Row & QueryResultRow>(sql, [...params]);
            return { rows: result.rows, rowCount: result.rowCount ?? 0 };
          },
        };
        const value = await operation(handle);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

function toInt(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^-?\d+$/u.test(value)) return Number(value);
  throw new Error(`ANVIL authority row carried a non-integer numeric: ${String(value)}`);
}

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  throw new Error(`ANVIL authority row carried a non-text value: ${String(value)}`);
}

function toNullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : toText(value);
}

function toTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  throw new Error(`ANVIL authority row carried a non-timestamp value: ${String(value)}`);
}

function toNullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined ? null : toTimestamp(value);
}

function toRoomStatus(value: unknown): RoomStatus {
  const text = toText(value);
  if (text === "active" || text === "archived" || text === "closed") return text;
  throw new Error(`ANVIL Room carried an unknown status: ${text}`);
}

function toBindingStatus(value: unknown): "active" | "replaced" | "released" {
  const text = toText(value);
  if (text === "active" || text === "replaced" || text === "released") return text;
  return "released";
}

/** Narrows an authority transition's `to`/`state` field to the known enum. */
export function toExecutionState(value: unknown): ExecutionState {
  const text = toText(value);
  const state = EXECUTION_STATES.find((candidate) => candidate === text);
  if (state === undefined) {
    throw new Error(`ANVIL transition carried an unknown state: ${text}`);
  }
  return state;
}

/** Narrows an authority transition's `substate` field to the known enum. */
export function toExecutionSubstate(value: unknown): ExecutionSubstate | null {
  if (value === null || value === undefined) return null;
  const text = toText(value);
  const substate = EXECUTION_SUBSTATES.find((candidate) => candidate === text);
  if (substate === undefined) {
    throw new Error(`ANVIL transition carried an unknown substate: ${text}`);
  }
  return substate;
}

/**
 * Maps a producer-form principal to its grant subject_kind. `agent:` refs need
 * a resolved subject_agent_id (not supported by this mint path — Hub v1
 * principals are always `device:`-form), so non-device/user prefixes fail.
 */
function grantSubjectKind(principal: string): "device" | "user" {
  if (principal.startsWith("operator:") || principal.startsWith("user:")) return "user";
  if (principal.startsWith("agent:")) {
    throw new Error("agent-form principals are not supported by the Hub grant mint");
  }
  return "device";
}

function toGrantSubjectKind(value: unknown): "agent" | "device" | "user" {
  const text = toText(value);
  if (text === "agent" || text === "device" || text === "user") return text;
  throw new Error(`ANVIL grant carried an unknown subject_kind: ${text}`);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
