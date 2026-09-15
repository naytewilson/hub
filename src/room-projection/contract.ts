/**
 * ANVIL Room read/projection contract (Campaign 3, Lane H1).
 *
 * Hub projects durable Room authority state owned by ANVIL/Postgres
 * (`anvil.rooms` / `anvil.room_participants` / `anvil.room_events` /
 * `anvil.capability_grants`, C2 `feat/room-authority-v1-20260915` @
 * b9e382bdf21cda0e7086cd143779a4d38a87aff4, migration v0_28). Hub never mints
 * room_id, room_seq, RoomEvent, CapabilityGrant, or ExecutionBinding and never
 * writes the authority tables — this surface is read-only projection per
 * DAG V1.1 ("Hub may cache projections; it may not become an alternative
 * truth ledger") and Foundation Interop V1 wire vocabulary.
 *
 * Field names on the projected records follow the Foundation wire form
 * (`room_id`, `room_seq`, `correlation_id`, `producer`, `idempotency_key`,
 * `occurred_at`), not Hub's camelCase API convention, because these are
 * ANVIL-owned identities passed through unchanged.
 */

export const ROOM_READ_CAPABILITY = "room.read" as const;

export const ROOM_EVENT_KINDS = [
  "message",
  "handoff",
  "approval",
  "evidence_ref",
  "execution",
  "system",
] as const;
export type RoomEventKind = (typeof ROOM_EVENT_KINDS)[number];

export const ROOM_STATUSES = ["active", "archived", "closed"] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

/**
 * The ANVIL subject identity the Hub instance reads as. Mirrors C2 `Actor`:
 * `agent` resolves through `anvil.agents.public_id`, `machine`/`operator` map
 * to `device`/`user` grant subjects by producer-form `subject_ref`, and
 * `service` is an ungrantable producer label — rejected at parse time, never
 * silently granted. Tailscale reachability, machine labels, and correlation
 * headers never satisfy this check; only a durable grant row does.
 */
export type AnvilRoomSubject =
  | { kind: "agent"; publicId: string }
  | { kind: "device"; subjectRef: string }
  | { kind: "user"; subjectRef: string };

const SUBJECT_REF_PATTERN = /^[a-z]+:[^\s:]+$/u;

export class AnvilSubjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnvilSubjectError";
  }
}

/**
 * Parses the producer-form subject binding (`agent:<uuid>`,
 * `machine:<machine_id>`, `operator:<user>`). `service:` identities are
 * ungrantable by C2 contract and are rejected here rather than failing later.
 */
export function parseAnvilSubject(value: string): AnvilRoomSubject {
  const trimmed = value.trim();
  if (!SUBJECT_REF_PATTERN.test(trimmed)) {
    throw new AnvilSubjectError(
      `ANVIL Room subject must be producer-form agent:<uuid> | machine:<id> | operator:<user>, got ${JSON.stringify(value)}`,
    );
  }
  const separator = trimmed.indexOf(":");
  const prefix = trimmed.slice(0, separator);
  const rest = trimmed.slice(separator + 1);
  switch (prefix) {
    case "agent":
      if (
        !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u.test(rest)
      ) {
        throw new AnvilSubjectError(
          `agent subject must carry an anvil.agents.public_id UUID, got ${JSON.stringify(trimmed)}`,
        );
      }
      return { kind: "agent", publicId: rest.toLowerCase() };
    case "machine":
      return { kind: "device", subjectRef: trimmed };
    case "operator":
      return { kind: "user", subjectRef: trimmed };
    case "service":
      throw new AnvilSubjectError(
        "service:* identities are ungrantable producer labels in the Room authority model and cannot read",
      );
    default:
      throw new AnvilSubjectError(`unknown ANVIL Room subject kind: ${JSON.stringify(prefix)}`);
  }
}

/** Producer-form label for errors/audit, e.g. `machine:anvil-node-01`. */
export function anvilSubjectLabel(subject: AnvilRoomSubject): string {
  return subject.kind === "agent" ? `agent:${subject.publicId}` : subject.subjectRef;
}

/** Projection of `anvil.rooms` — all values authority-minted, passed through. */
export interface ProjectedRoom {
  /** `anvil.rooms.public_id` — durable wire identity. */
  room_id: string;
  project_ref: string | null;
  status: RoomStatus;
  /** Room lineage correlation root (anvil.correlation.v1). */
  correlation_id: string;
  /** Committed high-water: MAX(room_seq), 0 for an empty room. */
  latest_seq: number;
  created_at: string;
  updated_at: string;
}

/** Projection of an ACTIVE `anvil.room_participants` period (left_seq IS NULL). */
export interface ProjectedRoomParticipant {
  /** `anvil.room_participants.public_id`. */
  participant_id: string;
  /** `anvil.agents.public_id` — durable agent identity, never a session. */
  agent_id: string;
  role: string;
  /** room_seq of the join system event. */
  joined_seq: number | null;
  /** Explicit-ACK high-water cursor. */
  acked_seq: number;
  joined_at: string;
}

/**
 * Projection of one committed `anvil.room_events` row. `room_seq` is the
 * canonical replay cursor assigned by the authority allocator — never
 * client-supplied, never renumbered here. Dedupe/projection identity is
 * `(room_id, room_seq)`.
 */
export interface ProjectedRoomEvent {
  /** `anvil.room_events.public_id`. */
  event_id: string;
  /** `anvil.rooms.public_id` — the owning room's wire identity. */
  room_id: string;
  room_seq: number;
  kind: RoomEventKind;
  /** Server-stamped producer form (`agent:<uuid>` | `service:<…>` | `operator:<…>` | `machine:<…>`). */
  producer: string;
  payload: Record<string, unknown>;
  /** anvil.correlation.v1 envelope (Foundation §3.2). */
  link: Record<string, unknown>;
  correlation_id: string;
  /** Wire ref to the immediate parent hop, never the root. */
  causation_id: string | null;
  /** `anvil.tasks.public_id` when task-scoped. */
  task_ref: string | null;
  campaign_id: string | null;
  /** `"<producer>:<producer_seq>"` or UUID — consumer dedupe key. */
  idempotency_key: string;
  /** Producer stamp — recorded, never ordering authority. */
  occurred_at: string | null;
  /** Authority stamp — ordering with room_seq. */
  created_at: string;
}
