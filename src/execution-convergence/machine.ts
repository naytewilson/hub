import { createHash } from "node:crypto";
import type { AgentExecutionRecord, Database } from "../db/types.js";
import type { DaemonEvent } from "../daemons/protocol.js";
import {
  CapabilityDeniedError,
  ExecutionNotBoundError,
  ExecutionNotFoundError,
  InvalidExecutionStateError,
  convergeTerminalReason,
  executionActionCapability,
  isHeldExecutionState,
  isTerminalExecutionState,
  type ExecutionAction,
  type ExecutionState,
  type ExecutionSubstate,
} from "./contract.js";
import {
  toExecutionState,
  toExecutionSubstate,
  type CapabilityGrantRecord,
  type ExecutionAuthorityGateway,
  type ResolvedExecutionBinding,
} from "./gateway.js";

/**
 * The I3 convergence machine: folds Paseo daemon/lifecycle signals into the
 * durable ANVIL execution lifecycle, and serves the I4 grant-scoped control
 * surface. The machine owns no durable state of its own — tracked state is a
 * cache hydrated from the latest committed `execution.transition`, so a Hub
 * restart resumes from authority rather than memory.
 *
 * Ordering guarantees relied upon:
 * - `observeDaemonEvent` is awaited at the top of `handleDaemonEvent`, inside
 *   the per-execution serialized queue — the authority event for a
 *   signal-caused terminal commits before the Hub-local transition runs.
 * - `observeTerminalIntent` is called inside the lifecycle's terminal funnel
 *   BEFORE the Hub row flips — authority first, so a Neo outage blocks the
 *   Hub-local terminalization rather than forking truth. For unbound
 *   executions both hooks no-op and Hub behavior is unchanged.
 * - All machine work is additionally serialized per execution id so control
 *   actions cannot interleave with in-flight signal handling.
 */
/** The observer half of the machine the daemon lifecycle depends on. */
export type ExecutionConvergenceObserver = Pick<
  ExecutionConvergence,
  "observeDaemonEvent" | "observeTerminalIntent"
>;

export interface ExecutionConvergence {
  /**
   * Map one daemon event into an authority transition. Errors propagate to the
   * caller — the lifecycle reports and continues (event-path convergence is
   * enriched by, and never blocks, Hub's own event handling).
   */
  observeDaemonEvent(executionId: string, daemonId: string, event: DaemonEvent): Promise<void>;
  /**
   * Emit a terminal transition before the Hub-local terminal write. No-op when
   * the execution is unbound or authority already shows it terminal. Throws on
   * authority failure — callers let it abort the Hub-local flip (fail closed).
   */
  observeTerminalIntent(input: {
    executionId: string;
    to: "succeeded" | "failed";
    /** Hub-local reason string, mapped via {@link convergeTerminalReason}. */
    hubReason?: string;
    /** Deterministic cause ref — also the idempotency discriminator. */
    causeRef: string;
    occurredAt?: Date;
  }): Promise<void>;
  /** I4: validate grant → execution → principal → expiry → state, then act. */
  performAction(input: PerformActionInput): Promise<ExecutionActionOutcome>;
  /** I4: mint a single-action capability grant for the caller principal. */
  mintGrant(input: MintExecutionGrantInput): Promise<MintedExecutionGrant>;
  /** I4 read side: current authority state for one bound execution. */
  describeExecution(executionId: string): Promise<ExecutionDescription>;
}

export interface PerformActionInput {
  executionId: string;
  action: ExecutionAction;
  grantId: string;
  /** Caller principal derived from the authenticated credential. */
  principal: string;
  requestId?: string;
}

export interface ExecutionActionOutcome {
  execution_id: string;
  state: ExecutionState;
  substate: ExecutionSubstate | null;
  room_seq: number;
  event_id: string;
  duplicate: boolean;
  retry_execution_id?: string;
  /** False when the daemon/Hub-side effect could not be applied. */
  effect_applied: boolean;
}

export interface MintExecutionGrantInput {
  executionId: string;
  action: ExecutionAction;
  principal: string;
  ttlSeconds: number;
}

export interface MintedExecutionGrant {
  grant_id: string;
  execution_id: string;
  action: ExecutionAction;
  principal: string;
  issued_at: string;
  expires_at: string;
  scope_hash: string;
}

export interface ExecutionDescription {
  execution_id: string;
  room_id: string;
  correlation_id: string;
  state: ExecutionState;
  substate: ExecutionSubstate | null;
  last_transition: {
    room_seq: number;
    event_id: string;
    occurred_at: string | null;
    causation_id: string | null;
  } | null;
}

export interface ExecutionConvergenceOptions {
  gateway: ExecutionAuthorityGateway;
  /** Hub-local projection — needed only for control actions (daemon id, intent). */
  database: Pick<Database, "findAgentExecutionById">;
  now?: () => Date;
  /** pause: daemon-side turn interrupt (execution held, not failed). */
  interruptExecution?(execution: AgentExecutionRecord): Promise<void>;
  /** cancel: Hub-side terminalization (rides the hub-action interrupt path). */
  cancelExecution?(execution: AgentExecutionRecord): Promise<void>;
  /**
   * start: kick dispatch of an undispatched durable execution; resolves false
   * when the Hub row cannot be kicked (dispatch already owned elsewhere).
   */
  resumeExecution?(execution: AgentExecutionRecord): Promise<boolean>;
  /**
   * retry: dispatch a new attempt carrying a deterministic id derived from
   * (source execution, grant) so a replayed call lands on the same attempt.
   */
  dispatchRetryAttempt?(execution: AgentExecutionRecord, attemptExecutionId: string): Promise<void>;
  report?(error: unknown, detail: Record<string, string>): void;
}

interface TrackedState {
  state: ExecutionState;
  substate: ExecutionSubstate | null;
}

export function createExecutionConvergence(
  options: ExecutionConvergenceOptions,
): ExecutionConvergence {
  const trackedByExecution = new Map<string, TrackedState>();
  const chainsByExecution = new Map<string, Promise<unknown>>();
  const now = options.now ?? (() => new Date());

  function enqueue<T>(executionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = chainsByExecution.get(executionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    chainsByExecution.set(executionId, current);
    const clear = () => {
      if (chainsByExecution.get(executionId) === current) {
        chainsByExecution.delete(executionId);
      }
    };
    void current.then(clear, clear);
    return current;
  }

  function track(resolved: ResolvedExecutionBinding): TrackedState {
    const existing = trackedByExecution.get(resolved.execution_id);
    if (existing !== undefined) return existing;
    const hydrated: TrackedState =
      resolved.last_transition === null
        ? { state: "queued", substate: null }
        : { state: resolved.last_transition.state, substate: resolved.last_transition.substate };
    trackedByExecution.set(resolved.execution_id, hydrated);
    return hydrated;
  }

  async function emitTransition(input: {
    resolved: ResolvedExecutionBinding;
    tracked: TrackedState;
    to: ExecutionState;
    substate: ExecutionSubstate | null;
    reason: string;
    causationId: string;
    idempotencyKey: string;
    actor: string;
    grantId?: string;
    extra?: Record<string, unknown>;
    occurredAt?: Date;
  }) {
    const committed = await options.gateway.appendTransition({
      roomInternalId: input.resolved.room_internal_id,
      room_id: input.resolved.room_id,
      execution_id: input.resolved.execution_id,
      binding_id: input.resolved.binding_id,
      correlation_id: input.resolved.correlation_id,
      from: input.tracked.state,
      to: input.to,
      substate: input.substate,
      reason: input.reason,
      causation_id: input.causationId,
      idempotency_key: input.idempotencyKey,
      actor: input.actor,
      ...(input.grantId === undefined ? {} : { grant_id: input.grantId }),
      ...(input.extra === undefined ? {} : { extra: input.extra }),
      ...(input.occurredAt === undefined ? {} : { occurred_at: input.occurredAt.toISOString() }),
    });
    // Adopt the committed winner's state — on duplicate delivery the authority
    // row is the truth, not our attempted transition.
    input.tracked.state = toExecutionState(committed.to);
    input.tracked.substate = toExecutionSubstate(committed.substate);
    return committed;
  }

  type SignalEmitter = (
    to: ExecutionState,
    substate: ExecutionSubstate | null,
    reason: string,
    discriminator: string,
  ) => Promise<unknown>;

  /**
   * Paseo signal → ANVIL transition. Never produces `parked`/`handed_off`
   * (authority-side only), never reopens a terminal state, never infers
   * completion from `idle` alone.
   */
  async function mapDaemonEvent(
    executionId: string,
    daemonId: string,
    event: DaemonEvent,
  ): Promise<void> {
    const resolved = await options.gateway.resolveExecution(executionId);
    if (resolved === undefined) return; // unbound executions stay Hub-local
    const tracked = track(resolved);
    if (isTerminalExecutionState(tracked.state)) return;

    const eventRef = `paseo:${daemonId}:${executionId}`;
    const emit: SignalEmitter = (to, substate, reason, discriminator) =>
      emitTransition({
        resolved,
        tracked,
        to,
        substate,
        reason,
        causationId: `${eventRef}:${discriminator}`,
        idempotencyKey: `hub-exec:${executionId}:${discriminator}`,
        actor: producerLabel(),
        occurredAt: new Date(event.timestamp),
      });

    if (event.type === "agent_update") {
      await mapAgentUpdate(emit, tracked, event);
      return;
    }
    await mapStreamEvent(emit, tracked, event.event, event.timestamp);
  }

  async function mapAgentUpdate(
    emit: SignalEmitter,
    tracked: TrackedState,
    event: Extract<DaemonEvent, { type: "agent_update" }>,
  ): Promise<void> {
    const held = isHeldExecutionState(tracked.state);
    switch (event.agent.status) {
      case "running":
        // A held execution cannot be re-driven by a Paseo signal.
        if (!held && tracked.state === "queued") {
          await emit("running", null, "agent_started", `agent_update:running:${event.timestamp}`);
        }
        return;
      case "idle":
        // An idle agent is not waiting on a tool; clear the substate only.
        if (!held && tracked.state === "running" && tracked.substate === "tool_wait") {
          await emit("running", null, "tool_wait_cleared", `agent_update:idle:${event.timestamp}`);
        }
        return;
      case "error":
      case "closed":
        // Daemon-reported interruption — the orphan rule. Always allowed out
        // of held states: the agent died underneath the hold.
        await emit(
          "failed",
          null,
          "agent_interrupted",
          `agent_update:${event.agent.status}:${event.timestamp}`,
        );
        return;
      case "initializing":
        return;
    }
  }

  async function mapStreamEvent(
    emit: SignalEmitter,
    tracked: TrackedState,
    stream: Extract<DaemonEvent, { type: "agent_stream" }>["event"],
    timestamp: string,
  ): Promise<void> {
    switch (stream.type) {
      case "thread_started":
      case "turn_started":
        if (!isHeldExecutionState(tracked.state) && tracked.state === "queued") {
          await emit("running", null, "agent_started", `stream:${stream.type}:${timestamp}`);
        }
        return;
      case "permission_requested":
      case "permission_resolved":
      case "attention_required":
        await mapToolWaitSignal(emit, tracked, stream, timestamp);
        return;
      case "timeline":
      case "turn_completed":
      case "turn_failed":
      case "turn_canceled":
        // Turn-level and progress signals carry no execution-state meaning.
        // `turn_canceled` in particular is NOT a cancel — Hub-initiated pause
        // and cancel interrupts also produce it; explicit cancel is an I4
        // control action with its own causation chain.
        return;
    }
  }

  /**
   * `PendingPermissions`/`requiresAttention` → `running` + `tool_wait`. A held
   * execution cannot move on a Paseo signal — the wait belongs to the turn.
   */
  async function mapToolWaitSignal(
    emit: SignalEmitter,
    tracked: TrackedState,
    stream: Extract<
      Extract<DaemonEvent, { type: "agent_stream" }>["event"],
      { type: "permission_requested" | "permission_resolved" | "attention_required" }
    >,
    timestamp: string,
  ): Promise<void> {
    if (isHeldExecutionState(tracked.state) || tracked.state !== "running") return;
    if (stream.type === "attention_required" && stream.reason !== "permission") return;
    if (stream.type === "permission_resolved") {
      if (tracked.substate === "tool_wait") {
        await emit(
          "running",
          null,
          "tool_wait_cleared",
          `stream:permission_resolved:${stream.requestId}:${timestamp}`,
        );
      }
      return;
    }
    if (tracked.substate !== "tool_wait") {
      await emit(
        "running",
        "tool_wait",
        "tool_wait_entered",
        `stream:${stream.type === "attention_required" ? "attention_required:permission" : "permission_requested"}:${timestamp}`,
      );
    }
  }

  function assertGrantUsable(
    grant: CapabilityGrantRecord,
    input: PerformActionInput,
    resolved: ResolvedExecutionBinding,
  ): void {
    if (grant.revoked_at !== null) throw new CapabilityDeniedError("grant revoked");
    if (grant.expires_at !== null && Date.parse(grant.expires_at) <= now().getTime()) {
      throw new CapabilityDeniedError("grant expired");
    }
    if (grant.capability !== executionActionCapability(input.action)) {
      throw new CapabilityDeniedError("grant action mismatch");
    }
    if (grant.correlation_id !== resolved.correlation_id) {
      throw new CapabilityDeniedError("grant correlation mismatch");
    }
    if (grant.subject_ref !== input.principal) {
      throw new CapabilityDeniedError("grant principal mismatch");
    }
    if (grant.scope_kind === "room" && grant.scope_room_id !== resolved.room_id) {
      throw new CapabilityDeniedError("grant scope mismatch");
    }
  }

  /**
   * I4 legality: which authority states each action may act from. Checked at
   * grant mint AND again at action time (state may drift between the two).
   */
  const ACTION_LEGALITY: Record<ExecutionAction, (tracked: TrackedState) => boolean> = {
    start: (tracked) => tracked.state === "queued",
    pause: (tracked) => tracked.state === "running",
    resume: (tracked) =>
      tracked.state === "paused" ||
      tracked.state === "parked" ||
      (tracked.state === "running" && tracked.substate === "tool_wait"),
    cancel: (tracked) => !isTerminalExecutionState(tracked.state),
    retry: (tracked) => tracked.state === "failed" || tracked.state === "cancelled",
    acknowledge: (tracked) => !isTerminalExecutionState(tracked.state),
  };

  function assertActionLegal(action: ExecutionAction, tracked: TrackedState): void {
    if (!ACTION_LEGALITY[action](tracked)) {
      throw new InvalidExecutionStateError(action, tracked.state);
    }
  }

  /** Deterministic retry attempt id — replaying a grant lands on one attempt. */
  function retryAttemptId(executionId: string, grantId: string): string {
    const bytes = createHash("sha256")
      .update("paseo-retry-execution-v1\0")
      .update(executionId)
      .update("\0")
      .update(grantId)
      .digest()
      .subarray(0, 16);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function controlIdempotencyKey(input: PerformActionInput): string {
    return input.action === "acknowledge"
      ? `hub-exec:${input.executionId}:control:acknowledge:${input.grantId}:${input.requestId ?? input.grantId}`
      : `hub-exec:${input.executionId}:control:${input.action}:${input.grantId}`;
  }

  /** Replay check: returns the committed winner when this action already ran. */
  async function committedControlOutcome(
    input: PerformActionInput,
    resolved: ResolvedExecutionBinding,
    tracked: TrackedState,
    idempotencyKey: string,
    retryExecutionId: string | undefined,
  ): Promise<ExecutionActionOutcome | undefined> {
    const existing = await options.gateway.findTransition(
      resolved.room_internal_id,
      idempotencyKey,
    );
    if (existing === undefined) return undefined;
    tracked.state = toExecutionState(existing.to);
    tracked.substate = toExecutionSubstate(existing.substate);
    const replayed: ExecutionActionOutcome = {
      execution_id: input.executionId,
      state: tracked.state,
      substate: tracked.substate,
      room_seq: existing.room_seq,
      event_id: existing.event_id,
      duplicate: true,
      effect_applied: true,
    };
    if (retryExecutionId !== undefined) {
      replayed.retry_execution_id = retryExecutionId;
    }
    return replayed;
  }

  /** The authority target a control action commits. */
  const CONTROL_TARGET_STATE: Partial<Record<ExecutionAction, ExecutionState>> = {
    start: "running",
    resume: "running",
    pause: "paused",
    cancel: "cancelled",
  };

  function controlTarget(
    action: ExecutionAction,
    tracked: TrackedState,
  ): { to: ExecutionState; substate: ExecutionSubstate | null; markerOnly: boolean } {
    const markerOnly =
      action === "acknowledge" ||
      action === "retry" ||
      (action === "resume" && tracked.state === "running" && tracked.substate === "tool_wait");
    return {
      to: CONTROL_TARGET_STATE[action] ?? tracked.state,
      substate:
        action === "acknowledge" || (action === "resume" && markerOnly) ? tracked.substate : null,
      markerOnly,
    };
  }

  /**
   * The live Hub/daemon effect a committed control transition causes. Runs
   * only for a fresh commit — a replayed action never re-applies effects.
   */
  async function applyControlEffect(
    input: PerformActionInput,
    execution: AgentExecutionRecord,
    markerOnly: boolean,
    retryExecutionId: string | undefined,
  ): Promise<boolean> {
    try {
      switch (input.action) {
        case "pause":
          if (execution.daemonId === null || options.interruptExecution === undefined) {
            return false;
          }
          await options.interruptExecution(execution);
          return true;
        case "cancel":
          if (options.cancelExecution === undefined) return false;
          await options.cancelExecution(execution);
          return true;
        case "start":
          return (await options.resumeExecution?.(execution)) ?? false;
        case "resume":
          // Held-state resume re-drives the launch intent; tool_wait resume is
          // marker-only (the agent still owns the turn).
          if (markerOnly) return true;
          return (await options.resumeExecution?.(execution)) ?? false;
        case "retry":
          if (options.dispatchRetryAttempt === undefined || retryExecutionId === undefined) {
            return false;
          }
          await options.dispatchRetryAttempt(execution, retryExecutionId);
          return true;
        default:
          return true;
      }
    } catch (error) {
      options.report?.(error, {
        executionId: input.executionId,
        kind: `action.${input.action}.effect`,
      });
      return false;
    }
  }

  /** I4 control path: grant → replay → legality → commit → live effect. */
  async function performControlAction(input: PerformActionInput): Promise<ExecutionActionOutcome> {
    const execution = await options.database.findAgentExecutionById(input.executionId);
    if (execution === undefined) throw new ExecutionNotFoundError(input.executionId);
    const resolved = await options.gateway.resolveExecution(input.executionId);
    if (resolved === undefined) throw new ExecutionNotBoundError(input.executionId);
    const grant = await options.gateway.findGrant(input.grantId);
    if (grant === undefined) throw new CapabilityDeniedError("grant not found");
    assertGrantUsable(grant, input, resolved);
    const tracked = track(resolved);

    const idempotencyKey = controlIdempotencyKey(input);
    // retry: deterministic attempt id is committed in the marker BEFORE
    // dispatch — a replayed call returns the committed winner instead of
    // minting a second attempt.
    const retryExecutionId =
      input.action === "retry" ? retryAttemptId(input.executionId, input.grantId) : undefined;

    // Replay BEFORE legality: a repeated action returns the committed
    // winner even when the execution's state has since moved on.
    const replayed = await committedControlOutcome(
      input,
      resolved,
      tracked,
      idempotencyKey,
      retryExecutionId,
    );
    if (replayed !== undefined) return replayed;

    assertActionLegal(input.action, tracked);
    const target = controlTarget(input.action, tracked);
    const committed = await emitTransition({
      resolved,
      tracked,
      to: target.to,
      substate: target.substate,
      reason: `operator_${input.action}`,
      causationId: `hub:control:${input.grantId}`,
      idempotencyKey,
      actor: input.principal,
      grantId: input.grantId,
      extra: {
        ...(input.action === "acknowledge" ? { acknowledged: true } : {}),
        ...(input.requestId === undefined ? {} : { request_id: input.requestId }),
        ...(input.action === "retry"
          ? { retry_of: input.executionId, retry_execution_id: retryExecutionId }
          : {}),
      },
    });

    const outcome: ExecutionActionOutcome = {
      execution_id: input.executionId,
      state: toExecutionState(committed.to),
      substate: toExecutionSubstate(committed.substate),
      room_seq: committed.room_seq,
      event_id: committed.event_id,
      duplicate: committed.duplicate,
      effect_applied: committed.duplicate
        ? true
        : await applyControlEffect(input, execution, target.markerOnly, retryExecutionId),
    };
    if (input.action === "retry" && retryExecutionId !== undefined) {
      // Deterministic attempt id: identical on every replay of this grant.
      outcome.retry_execution_id = retryExecutionId;
    }
    return outcome;
  }

  return {
    observeDaemonEvent(executionId, daemonId, event) {
      return enqueue(executionId, async () => {
        try {
          await mapDaemonEvent(executionId, daemonId, event);
        } catch (error) {
          options.report?.(error, { executionId, kind: "observeDaemonEvent" });
          // Event-path convergence never blocks Hub's own event handling —
          // the terminal funnel is the durable backstop for terminal signals.
        }
      });
    },

    observeTerminalIntent({ executionId, to, hubReason, causeRef, occurredAt }) {
      return enqueue(executionId, async () => {
        const resolved = await options.gateway.resolveExecution(executionId);
        if (resolved === undefined) return;
        const tracked = track(resolved);
        if (isTerminalExecutionState(tracked.state)) return;
        await emitTransition({
          resolved,
          tracked,
          to,
          substate: null,
          reason: to === "succeeded" ? "completed_by_agent" : convergeTerminalReason(hubReason),
          causationId: causeRef,
          idempotencyKey: `hub-exec:${executionId}:${causeRef}`,
          actor: producerLabel(),
          ...(occurredAt === undefined ? {} : { occurredAt }),
        });
      });
    },

    performAction(input) {
      return enqueue(input.executionId, () => performControlAction(input));
    },

    async mintGrant(input) {
      return enqueue(input.executionId, async () => {
        const execution = await options.database.findAgentExecutionById(input.executionId);
        if (execution === undefined) throw new ExecutionNotFoundError(input.executionId);
        const resolved = await options.gateway.resolveExecution(input.executionId);
        if (resolved === undefined) throw new ExecutionNotBoundError(input.executionId);
        assertActionLegal(input.action, track(resolved));
        const expiresAt = new Date(now().getTime() + input.ttlSeconds * 1000);
        const grant = await options.gateway.mintGrant({
          resolved,
          roomInternalId: resolved.room_internal_id,
          action: input.action,
          principal: input.principal,
          expires_at: expiresAt.toISOString(),
        });
        return {
          grant_id: grant.grant_id,
          execution_id: input.executionId,
          action: input.action,
          principal: input.principal,
          issued_at: grant.issued_at,
          expires_at: grant.expires_at ?? expiresAt.toISOString(),
          scope_hash: scopeHash(grant, input),
        };
      });
    },

    async describeExecution(executionId) {
      const resolved = await options.gateway.resolveExecution(executionId);
      if (resolved === undefined) throw new ExecutionNotBoundError(executionId);
      const tracked = track(resolved);
      return {
        execution_id: executionId,
        room_id: resolved.room_id,
        correlation_id: resolved.correlation_id,
        state: tracked.state,
        substate: tracked.substate,
        last_transition:
          resolved.last_transition === null
            ? null
            : {
                room_seq: resolved.last_transition.room_seq,
                event_id: resolved.last_transition.event_id,
                occurred_at: resolved.last_transition.occurred_at,
                causation_id: resolved.last_transition.causation_id,
              },
      };
    },
  };

  function producerLabel(): string {
    return options.gateway.producer;
  }

  function scopeHash(grant: CapabilityGrantRecord, input: MintExecutionGrantInput): string {
    return createHash("sha256")
      .update(
        [
          grant.grant_id,
          input.executionId,
          input.action,
          input.principal,
          grant.issued_at,
          grant.expires_at ?? "",
        ].join("|"),
      )
      .digest("hex");
  }
}
