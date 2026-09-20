import type { ApiKeyScope } from "../auth/api-key-contract.js";
import type { HubBundleFile } from "../config/bundle.js";
import type {
  AgentExecutionHubAcknowledgementInput,
  AgentExecutionRecord,
  ControlOperationRecord,
  ControlOperationStatus,
  InsertControlOperationInput,
  ListControlOperationsFilter,
  TriggerRunRecord,
} from "../db/types.js";
import type { DeploymentProjectResolution } from "../project-deployments/index.js";
import type {
  ControlOp,
  ProjectedRoom,
  ProjectedRoomEvent,
  ProjectedRoomParticipant,
  RoomAuthoritySource,
} from "../room-projection/index.js";
import type {
  ExecutionConvergence,
  ExecutionState,
  ExecutionSubstate,
} from "../execution-convergence/index.js";

export interface PublicAuthorization {
  kind: "apiKey" | "cliCredential";
  credentialId: string;
  organizationId: string;
  scopes: readonly ApiKeyScope[];
}

export interface InstallConfigurationInput {
  projectSlug?: string | undefined;
  files: readonly HubBundleFile[];
}

export type ValidateConfigurationInput = InstallConfigurationInput;

export type ValidateConfigurationResult =
  | { status: "valid"; projectSlug: string; valid: true; wouldCreateProject?: true }
  | { status: "project_not_found" }
  | { status: "invalid_bundle"; issues: readonly DomainIssue[] }
  | { status: "invalid_configuration"; issues: readonly DomainIssue[] }
  | InfrastructureUnavailable;

export interface PublicProject {
  id: string;
  name: string;
  slug: string;
}

export type ListProjectsResult =
  | { status: "listed"; projects: readonly PublicProject[] }
  | InfrastructureUnavailable;

export interface ConfigurationResources {
  daemons: readonly { id: string; slug: string }[];
  github: readonly {
    slug: string;
    accountLogin: string;
    accountType: string;
    repositories: readonly string[];
  }[];
  discord: readonly { slug: string; guildName: string }[];
  slack: readonly { slug: string; teamName: string }[];
  linear: readonly { slug: string; organizationName: string }[];
}

export type ListConfigurationResourcesResult =
  | ({ status: "listed" } & ConfigurationResources)
  | InfrastructureUnavailable;

export interface SetupResources {
  github: readonly {
    slug: string;
    accountLogin: string;
    accountType: string;
    repositories: readonly string[];
  }[];
  discord: readonly { guildId: string; guildName: string }[];
  slack: readonly { teamId: string; teamName: string }[];
}

export type ListSetupResourcesResult =
  | ({ status: "listed" } & SetupResources)
  | InfrastructureUnavailable;

export type InstallConfigurationResult =
  | {
      status: "installed";
      projectSlug: string;
      versionId: string;
      version: number;
      active: true;
    }
  | { status: "project_not_found" }
  | { status: "invalid_bundle"; issues: readonly DomainIssue[] }
  | {
      status: "invalid_configuration";
      versionId: string;
      issues: readonly DomainIssue[];
    }
  | InfrastructureUnavailable;

export interface DispatchManualRunInput {
  projectSlug: string;
  expectedVersionId?: string | undefined;
  trigger: string;
  actor: string;
  deliveryKey: string;
  input: unknown;
}

export type DispatchManualRunResult =
  | {
      status: "dispatched";
      deliveryKey: string;
      providerEventReceiptId: string;
      triggerRunId: string;
      configuredTriggerName: string;
      workflowStatus: "running" | "succeeded" | "failed" | "timed_out";
    }
  | { status: "project_not_found" }
  | { status: "actor_forbidden" }
  | { status: "daemon_offline" }
  | { status: "expected_configuration_not_current" }
  | { status: "configuration_not_found" }
  | { status: "trigger_not_found" }
  | {
      status: "invalid_input";
      providerEventReceiptId: string;
      triggerRunId: string;
      configuredTriggerName: string;
      issues: readonly DomainIssue[];
    }
  | { status: "dispatch_conflict" }
  | InfrastructureUnavailable;

export type IssueEnrollmentTokenResult =
  | { status: "issued"; token: string; expiresAt: Date }
  | { status: "credential_revoked" }
  | InfrastructureUnavailable;

export interface DomainIssue {
  path: readonly (string | number)[];
  message: string;
}

export interface InfrastructureUnavailable {
  status: "infrastructure_unavailable";
}

export interface TriggerYamlInput {
  yaml: string;
}

export type ValidateTriggerResult =
  | { status: "valid"; name: string; valid: true }
  | { status: "invalid_trigger"; issues: readonly DomainIssue[] }
  | InfrastructureUnavailable;

export type InstallTriggerResult =
  | {
      status: "installed";
      triggerId: string;
      name: string;
      revisionId: string;
      version: number;
      active: true;
    }
  | { status: "invalid_trigger"; issues: readonly DomainIssue[] }
  | InfrastructureUnavailable;

export interface PublicTrigger {
  id: string;
  name: string;
  enabled: boolean;
  format: "single_run" | "legacy_multistep";
  yaml: string;
}

export type ListTriggersResult =
  | { status: "listed"; triggers: readonly PublicTrigger[] }
  | InfrastructureUnavailable;

export interface RoomSnapshotInput {
  roomId: string;
}

export interface RoomEventsInput {
  roomId: string;
  after: number;
  limit: number;
}

/**
 * Freshness fields carried by every successful Room projection response
 * (I2/D5): `observed_at` is when the authority state backing the response was
 * observed by the projection seam; `stale` is `now - observed_at` beyond the
 * seam's configured freshness budget. The projection never claims authority —
 * these fields are the honest-freshness contract consumers rely on.
 */
export interface ProjectionEnvelope {
  observed_at: string;
  stale: boolean;
}

export type ListRoomsResult =
  | ({ status: "listed"; rooms: readonly ProjectedRoom[] } & ProjectionEnvelope)
  | { status: "room_projection_unavailable" }
  | InfrastructureUnavailable;

export type GetRoomSnapshotResult =
  | ({
      status: "ok";
      room: ProjectedRoom;
      participants: readonly ProjectedRoomParticipant[];
    } & ProjectionEnvelope)
  | { status: "room_not_found" }
  | { status: "capability_denied" }
  | { status: "room_projection_unavailable" }
  | InfrastructureUnavailable;

export type ReplayRoomEventsResult =
  | ({
      status: "ok";
      room: ProjectedRoom;
      events: readonly ProjectedRoomEvent[];
      latest_seq: number;
      next_cursor: number;
      has_more: boolean;
    } & ProjectionEnvelope)
  | { status: "room_not_found" }
  | { status: "capability_denied" }
  | { status: "room_projection_unavailable" }
  | InfrastructureUnavailable;

// --- I4 capability-scoped execution control (wire vocabulary is snake_case:
// every identity here is authority-minted and passed through unchanged) ---

export type ExecutionControlAction =
  | "start"
  | "pause"
  | "resume"
  | "cancel"
  | "retry"
  | "acknowledge";

export interface GetExecutionInput {
  executionId: string;
}

export interface MintExecutionGrantOperationInput {
  executionId: string;
  action: ExecutionControlAction;
  ttlSeconds?: number | undefined;
}

export interface ControlExecutionOperationInput {
  executionId: string;
  action: ExecutionControlAction;
  grantId: string;
  requestId?: string | undefined;
}

export type GetExecutionResult =
  | {
      status: "ok";
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
  | { status: "execution_not_found" }
  | { status: "capability_denied" }
  | { status: "room_not_found" }
  | { status: "execution_control_unavailable" }
  | InfrastructureUnavailable;

export type MintExecutionGrantResult =
  | {
      status: "minted";
      grant_id: string;
      execution_id: string;
      action: ExecutionControlAction;
      principal: string;
      issued_at: string;
      expires_at: string;
      scope_hash: string;
    }
  | { status: "execution_not_found" }
  | { status: "execution_not_bound" }
  | { status: "capability_denied" }
  | { status: "invalid_state" }
  | { status: "room_not_active" }
  | { status: "execution_control_unavailable" }
  | InfrastructureUnavailable;

export type ControlExecutionOperationResult =
  | {
      status: "applied";
      execution_id: string;
      state: ExecutionState;
      substate: ExecutionSubstate | null;
      room_seq: number;
      event_id: string;
      duplicate: boolean;
      effect_applied: boolean;
      retry_execution_id?: string;
    }
  | { status: "execution_not_found" }
  | { status: "execution_not_bound" }
  | { status: "capability_denied" }
  | { status: "invalid_state" }
  | { status: "room_not_active" }
  | { status: "execution_control_unavailable" }
  | InfrastructureUnavailable;

export interface PublicOperations {
  listTriggers(authorization: PublicAuthorization): Promise<ListTriggersResult>;
  validateTrigger(
    authorization: PublicAuthorization,
    input: TriggerYamlInput,
  ): Promise<ValidateTriggerResult>;
  installTrigger(
    authorization: PublicAuthorization,
    input: TriggerYamlInput,
  ): Promise<InstallTriggerResult>;
  listProjects(authorization: PublicAuthorization): Promise<ListProjectsResult>;
  listConfigurationResources(
    authorization: PublicAuthorization,
  ): Promise<ListConfigurationResourcesResult>;
  listSetupResources(authorization: PublicAuthorization): Promise<ListSetupResourcesResult>;
  validateConfiguration(
    authorization: PublicAuthorization,
    input: ValidateConfigurationInput,
  ): Promise<ValidateConfigurationResult>;
  installConfiguration(
    authorization: PublicAuthorization,
    input: InstallConfigurationInput,
  ): Promise<InstallConfigurationResult>;
  dispatchManualRun(
    authorization: PublicAuthorization,
    input: DispatchManualRunInput,
  ): Promise<DispatchManualRunResult>;
  issueEnrollmentToken(authorization: PublicAuthorization): Promise<IssueEnrollmentTokenResult>;
  listRooms(authorization: PublicAuthorization): Promise<ListRoomsResult>;
  getRoomSnapshot(
    authorization: PublicAuthorization,
    input: RoomSnapshotInput,
  ): Promise<GetRoomSnapshotResult>;
  replayRoomEvents(
    authorization: PublicAuthorization,
    input: RoomEventsInput,
  ): Promise<ReplayRoomEventsResult>;
  /** I4 Hub Control Contract V1. */
  resumeExecution(
    authorization: PublicAuthorization,
    input: ExecutionControlInput,
  ): Promise<ControlExecutionResult>;
  cancelExecution(
    authorization: PublicAuthorization,
    input: ExecutionControlInput,
  ): Promise<ControlExecutionResult>;
  retryExecution(
    authorization: PublicAuthorization,
    input: ExecutionControlInput,
  ): Promise<ControlExecutionResult>;
  acknowledgeAttention(
    authorization: PublicAuthorization,
    input: AcknowledgeAttentionInput,
  ): Promise<ControlExecutionResult>;
  startApprovedExecution(
    authorization: PublicAuthorization,
    input: StartApprovedExecutionInput,
  ): Promise<StartApprovedExecutionResult>;
  getControlOperation(
    authorization: PublicAuthorization,
    input: GetControlOperationInput,
  ): Promise<GetControlOperationResult>;
  listControlOperations(
    authorization: PublicAuthorization,
    input: ListControlOperationsInput,
  ): Promise<ListControlOperationsResult>;
  getExecution(
    authorization: PublicAuthorization,
    input: GetExecutionInput,
  ): Promise<GetExecutionResult>;
  mintExecutionGrant(
    authorization: PublicAuthorization,
    input: MintExecutionGrantOperationInput,
  ): Promise<MintExecutionGrantResult>;
  controlExecution(
    authorization: PublicAuthorization,
    input: ControlExecutionOperationInput,
  ): Promise<ControlExecutionOperationResult>;
}

export interface PublicOperationRepository {
  listActiveProjects(organizationId: string): Promise<readonly PublicProject[]>;
  listConfigurationResources(organizationId: string): Promise<ConfigurationResources>;
  listSetupResources(organizationId: string): Promise<SetupResources>;
  resolveManualRunProject(
    organizationId: string,
    triggerName: string,
    projectSlug: string,
  ): Promise<{ status: "resolved"; id: string } | { status: "disabled" } | undefined>;
  resolveDeploymentProject(input: {
    organizationId: string;
    explicitProjectSlug?: string | undefined;
    bundleName?: string | undefined;
    dryRun: boolean;
  }): Promise<DeploymentProjectResolution>;
  findManualRun(
    providerEventReceiptId: string,
    trigger: string,
  ): Promise<TriggerRunRecord | undefined>;
  issueEnrollmentToken(
    authorization: PublicAuthorization,
    input: { token: string; expiresAt: Date },
  ): Promise<"issued" | "credential_revoked" | "infrastructure_unavailable">;
  // --- I4 control plane (Hub Control Contract V1) ---
  /** Execution target lookup, org-scoped (cross-org ids resolve to undefined). */
  findAgentExecution(
    organizationId: string,
    executionId: string,
  ): Promise<AgentExecutionRecord | undefined>;
  /**
   * Durably requests the hub action on a live execution. Returns undefined
   * when the execution is missing, not live (spawning/running), or already
   * carries ANY pending hub action (I4 cancel requires a clean slate) —
   * the precondition gate for cancel.
   */
  requestExecutionHubAction(
    organizationId: string,
    executionId: string,
    action: "interrupt",
  ): Promise<AgentExecutionRecord | undefined>;
  recordExecutionHubAcknowledgement(
    organizationId: string,
    executionId: string,
    acknowledgement: AgentExecutionHubAcknowledgementInput,
  ): Promise<AgentExecutionRecord | undefined>;
  insertControlOperation(
    input: InsertControlOperationInput,
  ): Promise<{ inserted: boolean; record: ControlOperationRecord }>;
  findControlOperationById(
    organizationId: string,
    id: string,
  ): Promise<ControlOperationRecord | undefined>;
  findControlOperationByKey(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<ControlOperationRecord | undefined>;
  listControlOperations(
    organizationId: string,
    filter: ListControlOperationsFilter,
  ): Promise<ControlOperationRecord[]>;
}

export interface PublicOperationCapabilities {
  triggerForOrganization?(organizationId: string): {
    list(): Promise<readonly PublicTrigger[]>;
    validate(yaml: string): Promise<{ name: string }>;
    install(input: {
      yaml: string;
      credentialId: string;
      credentialKind: "apiKey" | "cliCredential";
    }): Promise<{ triggerId: string; name: string; revisionId: string; version: number }>;
  };
  configurationForProject(projectId: string): {
    validateBundle(
      files: readonly HubBundleFile[],
    ): Promise<{ valid: true } | { valid: false; validationErrors: unknown }>;
    insertManualBundleRevision(input: {
      files: readonly HubBundleFile[];
      userId: null;
      sourceEvidence: {
        kind: "api-key" | "cli-credential";
        credentialId: string;
      };
    }): Promise<{ id: string; validationErrors: unknown }>;
    activate(id: string): Promise<{ revision: { id: string; version: number } }>;
  };
  validateBundleForOrganization(
    organizationId: string,
    files: readonly HubBundleFile[],
  ): Promise<{ valid: true } | { valid: false; validationErrors: unknown }>;
  dispatchManualEvent(input: {
    organizationId: string;
    projectId: string;
    source: "manual.run";
    deliveryId: string;
    receivedAt: Date;
    payload: unknown;
  }): Promise<{ providerEventReceiptId: string } | void>;
  /**
   * The bound ANVIL Room read seam. Absent when the instance is not configured
   * for Room projection — operations then answer `room_projection_unavailable`
   * rather than serving unauthenticated or partially projected state.
   */
  roomAuthority?: RoomAuthoritySource;
  /**
   * The I3/I4 convergence machine — the authority write seam. Absent when the
   * instance is not configured for execution control; operations then answer
   * `execution_control_unavailable` rather than minting or acting unchecked.
   */
  executionConvergence?: ExecutionConvergence;
}

// ---------------------------------------------------------------------------
// I4 Hub Control Contract V1 — control-plane operation types
// ---------------------------------------------------------------------------

/** Wire form of a recorded control operation (Hub-minted; camelCase by Hub API convention). */
export interface ControlOperationWire {
  operationId: string;
  op: ControlOp;
  status: ControlOperationStatus;
  /** Present only on idempotent replay (HTTP 200). */
  replayed?: true;
  idempotencyKey: string;
  executionId: string | null;
  /** The ANVIL capability that authorized this op (control.<op>). */
  capability: string;
  /** Bound ANVIL subject label in producer form (the identity that was checked). */
  subject: string;
  /** I1 spine passthrough. */
  correlationId: string | null;
  /** The Hub-owned effect applied (per-op; see the frozen contract). */
  effect: unknown;
  createdAt: string;
  updatedAt: string;
}

function controlOperationEffectForWire(record: ControlOperationRecord): unknown {
  const effect = record.effect;
  if (
    record.op !== "execution_start" ||
    typeof effect !== "object" ||
    effect === null ||
    Array.isArray(effect)
  ) {
    return effect;
  }
  const publicEffect = { ...(effect as Record<string, unknown>) };
  delete publicEffect["requestTarget"];
  return publicEffect;
}

export function toControlOperationWire(record: ControlOperationRecord): ControlOperationWire {
  return {
    operationId: record.id,
    op: record.op,
    status: record.status,
    idempotencyKey: record.idempotencyKey,
    executionId: record.executionId,
    capability: record.capability,
    subject: record.subject,
    correlationId: record.correlationId,
    effect: controlOperationEffectForWire(record),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export interface ControlBaseInput {
  /** REQUIRED — idempotency key, 1–64 chars. Same key replays the stored result. */
  idempotencyKey: string;
  /** I1 spine passthrough (optional). */
  correlationId?: string | undefined;
}

export interface ExecutionControlInput extends ControlBaseInput {
  executionId: string;
}

export type AttentionKind = "terminal" | "idle" | "finish_execution_call";

export interface AcknowledgeAttentionInput extends ControlBaseInput {
  executionId: string;
  attentionKind: AttentionKind;
}

export interface StartApprovedExecutionInput extends ControlBaseInput {
  trigger: string;
  projectSlug: string;
  input?: unknown;
  actor?: unknown;
  expectedVersionId?: string | undefined;
}

export interface GetControlOperationInput {
  operationId: string;
}

export interface ListControlOperationsInput {
  executionId?: string | undefined;
  op?: ControlOp | undefined;
  status?: ControlOperationStatus | undefined;
  limit?: number | undefined;
}

export type ControlExecutionResult =
  | { status: "applied" | "recorded"; operation: ControlOperationWire }
  | { status: "replayed"; operation: ControlOperationWire }
  | { status: "invalid_input"; issues: readonly DomainIssue[] }
  | { status: "execution_not_found" }
  | { status: "control_capability_denied"; capability: string }
  | { status: "control_precondition_failed"; reason: string }
  | { status: "idempotency_key_conflict"; existingOperationId: string }
  | { status: "control_plane_unavailable" }
  | InfrastructureUnavailable;

export type StartApprovedExecutionResult =
  | ControlExecutionResult
  | { status: "project_not_found" }
  | { status: "trigger_not_found" }
  | { status: "invalid_input"; issues: readonly DomainIssue[] };

export type GetControlOperationResult =
  | { status: "ok"; operation: ControlOperationWire }
  | { status: "control_operation_not_found" }
  | { status: "control_plane_unavailable" }
  | InfrastructureUnavailable;

export type ListControlOperationsResult =
  | { status: "listed"; operations: readonly ControlOperationWire[] }
  | { status: "control_plane_unavailable" }
  | InfrastructureUnavailable;
