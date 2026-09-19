/**
 * I4 Hub Control Contract V1 — shared control-operation executor.
 *
 * Every control op runs the same spine: idempotency-key validation → ANVIL
 * capability check (server-side, durable, against the parallel ownership-map
 * contract — NEVER a transport scope) → per-op effect → durable idempotent
 * record in `control_operations`. Replays return the STORED operation with
 * `replayed: true`; a different op under an already-used key is a 409.
 */
import type {
  AgentExecutionHubAcknowledgementInput,
  AgentExecutionRecord,
  ControlOperationRecord,
} from "../db/types.js";
import {
  controlCapabilityFor,
  type ControlOp,
  type RoomAuthoritySource,
} from "../room-projection/index.js";
import type {
  ControlExecutionResult,
  DomainIssue,
  PublicAuthorization,
  PublicOperationCapabilities,
  PublicOperationRepository,
  StartApprovedExecutionInput,
} from "./types.js";
import { toControlOperationWire } from "./types.js";

export interface ControlInvocationInput {
  idempotencyKey: string;
  correlationId?: string | undefined;
  executionId?: string | undefined;
  attentionKind?: "terminal" | "idle" | "finish_execution_call" | undefined;
}

export type ControlOutcome =
  | { status: "ok"; durability: "applied" | "recorded"; effect: unknown }
  | { status: "execution_not_found" }
  | { status: "control_precondition_failed"; reason: string }
  | { status: "replay_stored"; existing: ControlOperationRecord };

export function validateControlInput(input: {
  idempotencyKey: string;
  correlationId?: string | undefined;
}): DomainIssue[] {
  const issues: DomainIssue[] = [];
  if (
    typeof input.idempotencyKey !== "string" ||
    input.idempotencyKey.length < 1 ||
    input.idempotencyKey.length > 64
  ) {
    issues.push({
      path: ["idempotencyKey"],
      message: "idempotencyKey must be a string of 1–64 characters",
    });
  }
  if (
    input.correlationId !== undefined &&
    (typeof input.correlationId !== "string" || input.correlationId.length === 0)
  ) {
    issues.push({
      path: ["correlationId"],
      message: "correlationId must be a non-empty string when provided",
    });
  }
  return issues;
}

export function resolveControlAuthority(
  capabilities: PublicOperationCapabilities,
): RoomAuthoritySource | undefined {
  return capabilities.roomAuthority;
}

export async function checkControlCapability(
  authority: RoomAuthoritySource,
  op: ControlOp,
): Promise<{ allowed: true } | { allowed: false; capability: string }> {
  const capability = controlCapabilityFor(op);
  const allowed = await authority.reader.holdsCapability(capability, null);
  return allowed ? { allowed: true } : { allowed: false, capability };
}

function acknowledgementKind(effect: unknown): string | undefined {
  if (typeof effect !== "object" || effect === null) return undefined;
  const acknowledgement = (effect as Record<string, unknown>)["acknowledgement"];
  if (typeof acknowledgement !== "object" || acknowledgement === null) return undefined;
  const kind = (acknowledgement as Record<string, unknown>)["kind"];
  return typeof kind === "string" ? kind : undefined;
}

export function replayOrConflict(
  existing: ControlOperationRecord,
  op: ControlOp,
  input: ControlInvocationInput,
): Extract<ControlExecutionResult, { status: "replayed" | "idempotency_key_conflict" }> {
  const sameTarget =
    existing.op === op &&
    existing.executionId === (input.executionId ?? null) &&
    (op !== "acknowledge" ||
      input.attentionKind === undefined ||
      acknowledgementKind(existing.effect) === input.attentionKind);
  if (sameTarget) {
    return {
      status: "replayed",
      operation: { ...toControlOperationWire(existing), replayed: true as const },
    };
  }
  return { status: "idempotency_key_conflict", existingOperationId: existing.id };
}

function startRequestTarget(effect: unknown): {
  trigger: string;
  projectSlug: string;
  expectedVersionId: string | null;
} | undefined {
  if (typeof effect !== "object" || effect === null) return undefined;
  const target = (effect as Record<string, unknown>)["requestTarget"];
  if (typeof target !== "object" || target === null) return undefined;
  const value = target as Record<string, unknown>;
  if (typeof value["trigger"] !== "string" || typeof value["projectSlug"] !== "string") {
    return undefined;
  }
  const expectedVersionId = value["expectedVersionId"];
  if (expectedVersionId !== null && typeof expectedVersionId !== "string") return undefined;
  return {
    trigger: value["trigger"],
    projectSlug: value["projectSlug"],
    expectedVersionId,
  };
}

export function replayStartOrConflict(
  existing: ControlOperationRecord,
  input: StartApprovedExecutionInput,
): Extract<ControlExecutionResult, { status: "replayed" | "idempotency_key_conflict" }> {
  const target = startRequestTarget(existing.effect);
  const sameTarget =
    existing.op === "execution_start" &&
    existing.executionId === null &&
    target !== undefined &&
    target.trigger === input.trigger &&
    target.projectSlug === input.projectSlug &&
    target.expectedVersionId === (input.expectedVersionId ?? null);
  if (sameTarget) {
    return {
      status: "replayed",
      operation: { ...toControlOperationWire(existing), replayed: true as const },
    };
  }
  return { status: "idempotency_key_conflict", existingOperationId: existing.id };
}

export interface ControlOperationExecutor {
  repository: PublicOperationRepository;
  capabilities: PublicOperationCapabilities;
}

/**
 * Runs one execution-targeted control op (resume/cancel/retry/acknowledge)
 * through the full spine. `execute` receives the org-scoped target (undefined
 * when the execution id is unknown to this org) and either applies/records the
 * effect or returns an error status. Database failures must surface as thrown
 * errors; the caller maps them to `infrastructure_unavailable`.
 */
export async function invokeControlOperation(
  executor: ControlOperationExecutor,
  authorization: PublicAuthorization,
  op: ControlOp,
  input: ControlInvocationInput,
  execute: (target: AgentExecutionRecord | undefined) => Promise<ControlOutcome>,
): Promise<ControlExecutionResult> {
  const { repository, capabilities } = executor;
  const organizationId = authorization.organizationId;

  const issues = validateControlInput(input);
  if (issues.length > 0) return { status: "invalid_input", issues };

  // Frozen V1 ordering: idempotency replay precedes the ANVIL capability
  // check. Replaying an operation that already executed under valid authority
  // exercises no new authority and must continue to work when the authority
  // seam is temporarily unavailable or the original grant later expires.
  const prior = await repository.findControlOperationByKey(organizationId, input.idempotencyKey);
  if (prior !== undefined) {
    return replayOrConflict(prior, op, input);
  }

  const authority = resolveControlAuthority(capabilities);
  if (authority === undefined) return { status: "control_plane_unavailable" };

  const check = await checkControlCapability(authority, op);
  if (!check.allowed) {
    return { status: "control_capability_denied", capability: check.capability };
  }

  const target =
    input.executionId === undefined
      ? undefined
      : await repository.findAgentExecution(organizationId, input.executionId);

  const outcome = await execute(target);
  if (outcome.status === "replay_stored") {
    return replayOrConflict(outcome.existing, op, input);
  }
  if (outcome.status !== "ok") return outcome;

  const { inserted, record } = await repository.insertControlOperation({
    organizationId,
    op,
    status: outcome.durability,
    idempotencyKey: input.idempotencyKey,
    executionId: input.executionId ?? null,
    capability: controlCapabilityFor(op),
    subject: authority.reader.subjectLabel(),
    correlationId: input.correlationId ?? null,
    effect: outcome.effect,
  });
  if (inserted) {
    return { status: outcome.durability, operation: toControlOperationWire(record) };
  }
  return replayOrConflict(record, op, input);
}

/** Builds the Hub acknowledgement input for the attention kinds the control plane owns. */
export function toHubAcknowledgement(
  kind: "terminal" | "idle",
  observedAt: Date,
): AgentExecutionHubAcknowledgementInput {
  return kind === "terminal" ? { kind: "terminal", observedAt } : { kind: "idle", observedAt };
}

/** execution_start input validation beyond the shared idempotency key checks. */
export function validateStartApprovedExecutionInput(
  input: StartApprovedExecutionInput,
): DomainIssue[] {
  const issues = validateControlInput(input);
  if (typeof input.trigger !== "string" || input.trigger.length === 0) {
    issues.push({ path: ["trigger"], message: "trigger must be a non-empty string" });
  }
  if (typeof input.projectSlug !== "string" || input.projectSlug.length === 0) {
    issues.push({ path: ["projectSlug"], message: "projectSlug must be a non-empty string" });
  }
  return issues;
}
