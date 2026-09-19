import { toDatabaseError } from "../db/errors.js";
import type { QueryHandle, QueryRow } from "../db/runtime/index.js";
import {
  anvilSubjectLabel,
  ROOM_READ_CAPABILITY,
  ROOM_STATUSES,
  type AnvilRoomSubject,
  type ObservedRead,
  type ProjectedRoom,
  type ProjectedRoomEvent,
  type ProjectedRoomParticipant,
  type RoomStatus,
} from "./contract.js";

export class RoomNotFoundError extends Error {
  constructor(public readonly roomId: string) {
    super(`room not found: ${roomId}`);
    this.name = "RoomNotFoundError";
  }
}

/** The bound subject holds no unexpired, unrevoked room.read grant on the room. */
export class RoomCapabilityDeniedError extends Error {
  constructor(
    public readonly capability: string,
    public readonly subject: string,
    public readonly roomId: string,
  ) {
    super(`capability denied: ${capability} for ${subject} on room ${roomId}`);
    this.name = "RoomCapabilityDeniedError";
  }
}

interface RoomRow extends QueryRow {
  id: unknown;
  public_id: unknown;
  project_ref: unknown;
  status: unknown;
  correlation_id: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface ParticipantRow extends QueryRow {
  participant_id: unknown;
  agent_id: unknown;
  role: unknown;
  joined_seq: unknown;
  acked_seq: unknown;
  joined_at: unknown;
}

interface EventRow extends QueryRow {
  event_id: unknown;
  room_seq: unknown;
  kind: unknown;
  producer: unknown;
  payload: unknown;
  link: unknown;
  correlation_id: unknown;
  causation_id: unknown;
  task_ref: unknown;
  campaign_id: unknown;
  idempotency_key: unknown;
  occurred_at: unknown;
  created_at: unknown;
}

interface IdRow extends QueryRow {
  id: unknown;
}

export interface RoomSnapshot {
  room: ProjectedRoom;
  participants: readonly ProjectedRoomParticipant[];
}

export interface RoomEventPage {
  room: ProjectedRoom;
  /** Events with room_seq > `after`, deduplicated on (room_id, room_seq), ascending. */
  events: readonly ProjectedRoomEvent[];
  /** Canonical high-water committed seq for the room (MAX(room_seq), 0 when empty). */
  latestSeq: number;
}

/**
 * Read-only seam over ANVIL Room authority. Every method mirrors the exact
 * SQL C2 executes inside the authority plane (`Rooms.swift` @ b9e382b):
 * - room resolve: `SELECT … FROM anvil.rooms WHERE public_id = $1`
 * - capability: `anvil.capability_grants` with `revoked_at IS NULL`,
 *   `(expires_at IS NULL OR expires_at > now())`, and
 *   `(scope_kind = 'global' OR scope_room_id = <room>)` — fail closed.
 * - replay: `WHERE room_id = $1 AND room_seq > $2 ORDER BY room_seq ASC`
 * - participants: ACTIVE periods joined to `anvil.agents.public_id`
 *
 * The C2 authority-plane `AuthorityContext` short-circuit is deliberately
 * absent: Hub is never inside the authority plane, so every read is
 * grant-checked. Identity alone is never permission.
 */
export interface RoomAuthorityReader {
  /** Rooms the bound subject can read (global or room-scoped room.read). */
  listReadableRooms(): Promise<ObservedRead<readonly ProjectedRoom[]>>;
  /** Room + active participants; 404/403 semantics preserved. */
  readSnapshot(roomPublicId: string): Promise<ObservedRead<RoomSnapshot>>;
  /**
   * Deterministic cursor replay: committed events with `room_seq > after`,
   * authority order, bounded by `limit`. Re-issuing the same cursor yields
   * the same event sequence for unchanged authority state; duplicated rows
   * collapse on (room_id, room_seq) so projection stays idempotent.
   */
  replayEvents(
    roomPublicId: string,
    after: number,
    limit: number,
  ): Promise<ObservedRead<RoomEventPage>>;
  /**
   * Durable capability check for the bound subject: an unrevoked, unexpired
   * grant for `capability`. With a null room scope only global grants satisfy
   * the check (I4 V1 control capabilities are global-scoped); with a room
   * public id, global or that room's grant satisfies it. Mirrors the H1
   * `room.read` predicate exactly — Hub is outside the authority plane, so the
   * grant table is always consulted.
   */
  holdsCapability(capability: string, scopeRoomPublicId: string | null): Promise<boolean>;
  /**
   * The bound ANVIL subject's producer-form label (`agent:<public_id>` or the
   * device/user `subject_ref`) — the identity every capability check above is
   * evaluated against. Recorded as the authorizing subject on control ops.
   */
  subjectLabel(): string;
}

export function createRoomAuthorityReader(
  handle: QueryHandle,
  subject: AnvilRoomSubject,
): RoomAuthorityReader {
  async function query<Row extends QueryRow>(
    text: string,
    values: readonly unknown[],
  ): Promise<Row[]> {
    try {
      const result = await handle.query<Row>(text, values);
      return result.rows;
    } catch (error) {
      throw toDatabaseError(error);
    }
  }

  async function resolveRoom(
    roomPublicId: string,
  ): Promise<(RoomRow & { id: number }) | undefined> {
    const rows = await query<RoomRow>(
      `SELECT id, public_id, project_ref, status, correlation_id, created_at, updated_at
       FROM anvil.rooms WHERE public_id = $1`,
      [roomPublicId],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return { ...row, id: toInt(row.id) };
  }

  /**
   * Mirrors C2 `actorHolds` exactly: agents match `subject_agent_id` (after
   * resolving public_id → internal id), device/user match `subject_ref` in
   * producer form. No ambient authority short-circuit — Hub is outside the
   * authority plane, so the grant table is always consulted. A null
   * roomInternalId means "global scope only" (I4 V1 control capabilities).
   */
  async function subjectHoldsCapability(
    capability: string,
    roomInternalId: number | null,
  ): Promise<boolean> {
    if (subject.kind === "agent") {
      const agentId = await agentInternalId();
      if (agentId === undefined) return false;
      const rows = await query(
        `SELECT 1 FROM anvil.capability_grants
         WHERE subject_kind = 'agent'
           AND subject_agent_id = $1
           AND capability = $2
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > now())
           AND (scope_kind = 'global' OR ($3::bigint IS NOT NULL AND scope_room_id = $3))
         LIMIT 1`,
        [agentId, capability, roomInternalId],
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
         AND (scope_kind = 'global' OR ($4::bigint IS NOT NULL AND scope_room_id = $4))
       LIMIT 1`,
      [subject.kind, subject.subjectRef, capability, roomInternalId],
    );
    return rows.length > 0;
  }

  async function subjectHoldsRead(roomInternalId: number): Promise<boolean> {
    return subjectHoldsCapability(ROOM_READ_CAPABILITY, roomInternalId);
  }

  async function requireReadableRoom(roomPublicId: string): Promise<RoomRow & { id: number }> {
    const room = await resolveRoom(roomPublicId);
    if (room === undefined) throw new RoomNotFoundError(roomPublicId);
    if (!(await subjectHoldsRead(room.id))) {
      throw new RoomCapabilityDeniedError(
        ROOM_READ_CAPABILITY,
        anvilSubjectLabel(subject),
        roomPublicId,
      );
    }
    return room;
  }

  function projectRoom(row: RoomRow & { id: number }, latestSeq: number): ProjectedRoom {
    return {
      room_id: toText(row.public_id),
      project_ref: toNullableText(row.project_ref),
      status: toRoomStatus(row.status),
      correlation_id: toText(row.correlation_id),
      latest_seq: latestSeq,
      created_at: toTimestamp(row.created_at),
      updated_at: toTimestamp(row.updated_at),
    };
  }

  async function latestCommittedSeq(roomInternalId: number): Promise<number> {
    const rows = await query<{ m: unknown }>(
      `SELECT COALESCE(MAX(room_seq), 0) AS m FROM anvil.room_events WHERE room_id = $1`,
      [roomInternalId],
    );
    return toInt(rows[0]?.m ?? 0);
  }

  return {
    subjectLabel() {
      return anvilSubjectLabel(subject);
    },

    async holdsCapability(capability, scopeRoomPublicId) {
      if (scopeRoomPublicId === null) return subjectHoldsCapability(capability, null);
      const room = await resolveRoom(scopeRoomPublicId);
      if (room === undefined) return false;
      return subjectHoldsCapability(capability, room.id);
    },

    async listReadableRooms() {
      // Grant-filtered list — global room.read covers every room; room-scoped
      // grants cover only their scope_room_id. Same predicate as
      // subjectHoldsRead, expressed per row so one query returns the visible set.
      const agentId = subject.kind === "agent" ? await agentInternalId() : undefined;
      if (subject.kind === "agent" && agentId === undefined) {
        return { value: [], observed_at: new Date().toISOString() };
      }
      const grantPredicate =
        subject.kind === "agent"
          ? `g.subject_kind = 'agent' AND g.subject_agent_id = $1 AND g.capability = $2`
          : `g.subject_kind = $1 AND g.subject_ref = $2 AND g.capability = $3`;
      const binds: unknown[] =
        subject.kind === "agent"
          ? [agentId, ROOM_READ_CAPABILITY]
          : [subject.kind, subject.subjectRef, ROOM_READ_CAPABILITY];
      const rows = await query<RoomRow & { latest_seq: unknown }>(
        `SELECT r.id, r.public_id, r.project_ref, r.status, r.correlation_id,
                r.created_at, r.updated_at,
                COALESCE((SELECT MAX(e.room_seq) FROM anvil.room_events e
                          WHERE e.room_id = r.id), 0) AS latest_seq
         FROM anvil.rooms r
         WHERE EXISTS (
           SELECT 1 FROM anvil.capability_grants g
           WHERE ${grantPredicate}
             AND g.revoked_at IS NULL
             AND (g.expires_at IS NULL OR g.expires_at > now())
             AND (g.scope_kind = 'global' OR g.scope_room_id = r.id)
         )
         ORDER BY r.created_at ASC, r.id ASC`,
        binds,
      );
      const value = rows.map((row) =>
        projectRoom({ ...row, id: toInt(row.id) }, toInt(row.latest_seq)),
      );
      return { value, observed_at: new Date().toISOString() };
    },

    async readSnapshot(roomPublicId) {
      const room = await requireReadableRoom(roomPublicId);
      const participants = await query<ParticipantRow>(
        `SELECT p.public_id AS participant_id, a.public_id AS agent_id,
                p.role, p.joined_seq, p.acked_seq, p.joined_at
         FROM anvil.room_participants p
         JOIN anvil.agents a ON a.id = p.agent_id
         WHERE p.room_id = $1 AND p.left_seq IS NULL
         ORDER BY p.id`,
        [room.id],
      );
      const value: RoomSnapshot = {
        room: projectRoom(room, await latestCommittedSeq(room.id)),
        participants: participants.map((row) => ({
          participant_id: toText(row.participant_id),
          agent_id: toText(row.agent_id),
          role: toText(row.role),
          joined_seq: toNullableInt(row.joined_seq),
          acked_seq: toInt(row.acked_seq),
          joined_at: toTimestamp(row.joined_at),
        })),
      };
      return { value, observed_at: new Date().toISOString() };
    },

    async replayEvents(roomPublicId, after, limit) {
      const room = await requireReadableRoom(roomPublicId);
      const [events, latestSeq] = await Promise.all([
        queryEvents(room.id, after, limit),
        latestCommittedSeq(room.id),
      ]);
      const roomId = toText(room.public_id);
      // Idempotent projection: dedupe on (room_id, room_seq). The authority
      // UNIQUE(room_id, room_seq) constraint makes duplicates impossible
      // upstream; this guard keeps the projection contract independent of
      // that invariant so a re-delivered row can never become duplicate
      // semantic state.
      const seen = new Set<number>();
      const value: RoomEventPage = {
        room: projectRoom(room, latestSeq),
        latestSeq,
        events: events
          .map((row) => projectEvent(row, roomId))
          .filter((event) => {
            if (seen.has(event.room_seq)) return false;
            seen.add(event.room_seq);
            return true;
          }),
      };
      return { value, observed_at: new Date().toISOString() };
    },
  };

  async function queryEvents(
    roomInternalId: number,
    after: number,
    limit: number,
  ): Promise<EventRow[]> {
    return query<EventRow>(
      `SELECT e.public_id AS event_id, e.room_seq, e.kind, e.producer,
              e.payload, e.link, e.correlation_id, e.causation_id,
              e.task_ref, e.campaign_id, e.idempotency_key,
              e.occurred_at, e.created_at
       FROM anvil.room_events e
       WHERE e.room_id = $1 AND e.room_seq > $2
       ORDER BY e.room_seq ASC
       LIMIT $3`,
      [roomInternalId, after, limit],
    );
  }

  async function agentInternalId(): Promise<number | undefined> {
    if (subject.kind !== "agent") return undefined;
    const rows = await query<IdRow>(`SELECT id FROM anvil.agents WHERE public_id = $1`, [
      subject.publicId,
    ]);
    const row = rows[0];
    return row === undefined ? undefined : toInt(row.id);
  }
}

function projectEvent(row: EventRow, roomId: string): ProjectedRoomEvent {
  return {
    event_id: toText(row.event_id),
    room_id: roomId,
    room_seq: toInt(row.room_seq),
    kind: toText(row.kind),
    producer: toText(row.producer),
    payload: toJsonObject(row.payload),
    link: toJsonObject(row.link),
    correlation_id: toText(row.correlation_id),
    causation_id: toNullableText(row.causation_id),
    task_ref: toNullableText(row.task_ref),
    campaign_id: toNullableText(row.campaign_id),
    idempotency_key: toText(row.idempotency_key),
    occurred_at: toNullableTimestamp(row.occurred_at),
    created_at: toTimestamp(row.created_at),
  };
}

function toInt(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^-?\d+$/u.test(value)) return Number(value);
  throw new Error(`ANVIL Room row carried a non-integer numeric: ${String(value)}`);
}

function toNullableInt(value: unknown): number | null {
  return value === null || value === undefined ? null : toInt(value);
}

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  throw new Error(`ANVIL Room row carried a non-text value: ${String(value)}`);
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
  throw new Error(`ANVIL Room row carried a non-timestamp value: ${String(value)}`);
}

function toNullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined ? null : toTimestamp(value);
}

function toJsonObject(value: unknown): Record<string, unknown> {
  return isJsonObject(value) ? value : {};
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toRoomStatus(value: unknown): RoomStatus {
  const text = toText(value);
  const status = ROOM_STATUSES.find((candidate) => candidate === text);
  if (status === undefined) {
    throw new Error(`ANVIL Room carried an unknown status: ${text}`);
  }
  return status;
}
