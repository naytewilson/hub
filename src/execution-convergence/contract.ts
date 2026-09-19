/**
 * ANVIL execution-convergence contract (Campaign I3/I4, DESIGN-I1-I7 §4/§5).
 *
 * The durable execution lifecycle machine lives in ANVIL Room authority
 * (`anvil.room_events` rows of kind {@link EXECUTION_TRANSITION_KIND}) — never in
 * Paseo's native agent enum (`idle|running|error|closed|initializing`), which
 * this module reads but never redefines. Hub synthesizes the richer states and
 * persists every transition authority-side before (or with) the Hub-local
 * effect it causes.
 *
 * Field names on authority-facing records follow the Foundation wire form
 * (`execution_id`, `correlation_id`, `causation_id`, `room_seq`, `grant_id`),
 * not Hub's camelCase API convention — these are ANVIL-owned identities.
 */

/** Authority event kind for execution lifecycle transitions (i1 migration v0_33). */
export const EXECUTION_TRANSITION_KIND = "execution.transition" as const;

/** Durable ANVIL execution lifecycle — synthesized Hub-side, owned by authority. */
export const EXECUTION_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "paused",
  "handed_off",
  "parked",
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

/** Nullable substate axis — extended only by evidence. */
export const EXECUTION_SUBSTATES = ["tool_wait"] as const;
export type ExecutionSubstate = (typeof EXECUTION_SUBSTATES)[number];

export const TERMINAL_EXECUTION_STATES: readonly ExecutionState[] = [
  "succeeded",
  "failed",
  "cancelled",
];

/**
 * States produced only by Hub/authority initiative — a Paseo daemon signal can
 * never move an execution out of them; only a grant-scoped control action can.
 */
export const HELD_EXECUTION_STATES: readonly ExecutionState[] = ["paused", "parked", "handed_off"];

export function isTerminalExecutionState(state: ExecutionState): boolean {
  return TERMINAL_EXECUTION_STATES.includes(state);
}

export function isHeldExecutionState(state: ExecutionState): boolean {
  return HELD_EXECUTION_STATES.includes(state);
}

/** I4 control actions — each maps to the authority capability `execution.<action>`. */
export const EXECUTION_ACTIONS = [
  "start",
  "pause",
  "resume",
  "cancel",
  "retry",
  "acknowledge",
] as const;
export type ExecutionAction = (typeof EXECUTION_ACTIONS)[number];

export function executionActionCapability(action: ExecutionAction): string {
  return `execution.${action}`;
}

/**
 * The I4 caller principal v1: derived from the authenticated Hub credential.
 * Stored authority-side as `subject_kind='device'`,
 * `subject_ref=device:hub-credential:<credentialId>` — producer-form identity,
 * never a session, token, or API key material.
 */
export function hubCredentialPrincipal(credentialId: string): string {
  return `device:hub-credential:${credentialId}`;
}

/**
 * Canonical transition reasons. `operator_*` is control-plane (I4 grant-scoped);
 * the rest are convergence-plane (I3 daemon/lifecycle signals).
 */
export const EXECUTION_TRANSITION_REASONS = [
  "agent_started",
  "tool_wait_entered",
  "tool_wait_cleared",
  "completed_by_agent",
  "agent_interrupted",
  "daemon_disconnected",
  "timed_out",
  "dispatch_failed",
  "operator_start",
  "operator_pause",
  "operator_resume",
  "operator_cancel",
  "operator_retry",
  "operator_acknowledge",
] as const;
export type ExecutionTransitionReason = (typeof EXECUTION_TRANSITION_REASONS)[number];

/** Lifecycle timeout-family reasons map to the ANVIL reason `timed_out`. */
const TIMEOUT_REASONS = new Set([
  "timeout",
  "idle_timeout",
  "step_idle_timeout",
  "step_hard_timeout",
  "whole_run_timeout",
]);

/** Maps a Hub-local terminal reason to the ANVIL transition reason vocabulary. */
export function convergeTerminalReason(hubReason: string | undefined): ExecutionTransitionReason {
  if (hubReason === undefined) return "completed_by_agent";
  if (TIMEOUT_REASONS.has(hubReason)) return "timed_out";
  if (hubReason === "agent_interrupted") return "agent_interrupted";
  if (hubReason === "daemon_disconnected") return "daemon_disconnected";
  if (hubReason === "operator_cancelled") return "operator_cancel";
  return "dispatch_failed";
}

/**
 * Fail-closed domain error for the convergence/control surface. `code` is the
 * wire status the public operations layer maps to HTTP; the taxonomy is fixed
 * so `capability_denied` can never collapse into `insufficient_scope`.
 */
export type ExecutionControlErrorCode =
  | "execution_not_found"
  | "execution_not_bound"
  | "capability_denied"
  | "invalid_state"
  | "room_not_active";

export class ExecutionControlError extends Error {
  constructor(
    readonly code: ExecutionControlErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ExecutionControlError";
  }
}

/** The execution has no active authority binding — control cannot reach it. */
export class ExecutionNotBoundError extends ExecutionControlError {
  constructor(executionId: string) {
    super("execution_not_bound", `execution ${executionId} has no active ANVIL execution_binding`);
    this.name = "ExecutionNotBoundError";
  }
}

/** The Hub-local projection does not know this execution id at all. */
export class ExecutionNotFoundError extends ExecutionControlError {
  constructor(executionId: string) {
    super("execution_not_found", `execution not found: ${executionId}`);
    this.name = "ExecutionNotFoundError";
  }
}

/**
 * Grant failed validation: missing, revoked, expired, wrong action, wrong
 * correlation, wrong room scope, or presented by a different principal.
 * Deliberately indistinct on the wire — the grant store does not oracle.
 */
export class CapabilityDeniedError extends ExecutionControlError {
  constructor(detail: string) {
    super("capability_denied", `capability denied: ${detail}`);
    this.name = "CapabilityDeniedError";
  }
}

/** The requested action is not legal from the execution's current authority state. */
export class InvalidExecutionStateError extends ExecutionControlError {
  constructor(action: string, state: ExecutionState) {
    super("invalid_state", `action ${action} is not valid from execution state ${state}`);
    this.name = "InvalidExecutionStateError";
  }
}

/** The owning Room is not active — authority rejects further appends. */
export class RoomNotActiveError extends ExecutionControlError {
  constructor(roomId: string, status: string) {
    super("room_not_active", `room ${roomId} is not active (status ${status})`);
    this.name = "RoomNotActiveError";
  }
}
