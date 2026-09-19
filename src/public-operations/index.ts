import { createHash, randomBytes } from "node:crypto";
import { configurationValidationIssues } from "../configuration/validation-errors.js";
import { ConfigurationActivationValidationError } from "../configuration/store.js";
import { compileHubBundle, HubBundleError } from "../config/bundle.js";
import type { DaemonClock } from "../daemons/index.js";
import { DaemonDispatchFailure } from "../daemons/index.js";
import { ENROLLMENT_LIFETIME_MS } from "../daemons/registration.js";
import { isDatabaseUnavailableError } from "../db/errors.js";
import { formatInvocationRejection } from "../triggers/invocation.js";
import { ManualRunRejected } from "../triggers/manual/provider.js";
import type {
  DispatchManualRunInput,
  DispatchManualRunResult,
  PublicOperationCapabilities,
  PublicOperationRepository,
  PublicOperations,
} from "./types.js";
import { toControlOperationWire } from "./types.js";
import {
  controlCapabilityFor,
  RoomCapabilityDeniedError,
  RoomNotFoundError,
  SIEVE_PROJECTION_EVENT_KIND,
  type EventFreshness,
  type ObservedRead,
  type ProjectedRoomEvent,
  type RoomAuthoritySource,
} from "../room-projection/index.js";
import {
  checkControlCapability,
  invokeControlOperation,
  replayOrConflict,
  resolveControlAuthority,
  toHubAcknowledgement,
  validateStartApprovedExecutionInput,
} from "./control-operations.js";
import { TriggerDocumentError } from "../triggers/configuration/index.js";

export type * from "./types.js";

export function createPublicOperations(
  repository: PublicOperationRepository,
  capabilities: PublicOperationCapabilities,
  clock: DaemonClock = { nowDate: () => new Date() },
): PublicOperations {
  return {
    async listTriggers(authorization) {
      try {
        return {
          status: "listed",
          triggers: await triggerCapability(capabilities, authorization.organizationId).list(),
        };
      } catch (error) {
        return storageUnavailableOrThrow(error);
      }
    },
    async validateTrigger(authorization, input) {
      try {
        const trigger = await triggerCapability(
          capabilities,
          authorization.organizationId,
        ).validate(input.yaml);
        return { status: "valid", name: trigger.name, valid: true };
      } catch (error) {
        if (error instanceof TriggerDocumentError) {
          return { status: "invalid_trigger", issues: error.issues };
        }
        return storageUnavailableOrThrow(error);
      }
    },
    async installTrigger(authorization, input) {
      try {
        const installed = await triggerCapability(
          capabilities,
          authorization.organizationId,
        ).install({
          yaml: input.yaml,
          credentialId: authorization.credentialId,
          credentialKind: authorization.kind,
        });
        return { status: "installed", ...installed, active: true };
      } catch (error) {
        if (error instanceof TriggerDocumentError) {
          return { status: "invalid_trigger", issues: error.issues };
        }
        return storageUnavailableOrThrow(error);
      }
    },
    async listProjects(authorization) {
      try {
        return {
          status: "listed",
          projects: await repository.listActiveProjects(authorization.organizationId),
        };
      } catch (error) {
        return storageUnavailableOrThrow(error);
      }
    },
    async listConfigurationResources(authorization) {
      try {
        return {
          status: "listed",
          ...(await repository.listConfigurationResources(authorization.organizationId)),
        };
      } catch (error) {
        return storageUnavailableOrThrow(error);
      }
    },
    async listSetupResources(authorization) {
      try {
        return {
          status: "listed",
          ...(await repository.listSetupResources(authorization.organizationId)),
        };
      } catch (error) {
        return storageUnavailableOrThrow(error);
      }
    },
    async validateConfiguration(authorization, input) {
      try {
        const resolved = await resolveConfigurationDeployment(
          repository,
          authorization.organizationId,
          input,
          true,
        );
        if (!resolved.success) return resolved.result;
        const { target } = resolved;
        const result =
          target.status === "would_create"
            ? await capabilities.validateBundleForOrganization(
                authorization.organizationId,
                resolved.files,
              )
            : await capabilities
                .configurationForProject(target.project.id)
                .validateBundle(resolved.files);
        const projectSlug =
          target.status === "would_create" ? target.projectSlug : target.project.slug;
        return result.valid
          ? {
              status: "valid",
              projectSlug,
              valid: true,
              ...(target.status === "would_create" ? { wouldCreateProject: true as const } : {}),
            }
          : {
              status: "invalid_configuration",
              issues: configurationValidationIssues(result.validationErrors),
            };
      } catch (error) {
        return storageUnavailableOrThrow(error);
      }
    },
    async installConfiguration(authorization, input) {
      try {
        const resolved = await resolveConfigurationDeployment(
          repository,
          authorization.organizationId,
          input,
          false,
        );
        if (!resolved.success) return resolved.result;
        const { target } = resolved;
        if (target.status === "would_create") throw new Error("install project was not resolved");
        const project = target.project;
        const configuration = capabilities.configurationForProject(project.id);
        const record = await configuration.insertManualBundleRevision({
          files: resolved.files,
          userId: null,
          sourceEvidence: {
            kind: authorization.kind === "apiKey" ? "api-key" : "cli-credential",
            credentialId: authorization.credentialId,
          },
        });
        if (record.validationErrors !== null) {
          return {
            status: "invalid_configuration",
            versionId: record.id,
            issues: configurationValidationIssues(record.validationErrors),
          };
        }
        let promoted: Awaited<ReturnType<typeof configuration.activate>>;
        try {
          promoted = await configuration.activate(record.id);
        } catch (error) {
          if (!(error instanceof ConfigurationActivationValidationError)) throw error;
          return {
            status: "invalid_configuration",
            versionId: record.id,
            issues: configurationValidationIssues(error.validationErrors),
          };
        }
        return {
          status: "installed",
          projectSlug: project.slug,
          versionId: promoted.revision.id,
          version: promoted.revision.version,
          active: true,
        };
      } catch (error) {
        return storageUnavailableOrThrow(error);
      }
    },
    async dispatchManualRun(authorization, input) {
      try {
        const project = await repository.resolveManualRunProject(
          authorization.organizationId,
          input.trigger,
          input.projectSlug,
        );
        if (project === undefined) return { status: "project_not_found" };
        if (project.status === "disabled") return { status: "trigger_not_found" };
        let result: DispatchManualRunResult;
        try {
          result = await dispatchManualRun(
            repository,
            capabilities,
            authorization,
            project.id,
            input,
            internalDeliveryId(authorization.organizationId, project.id, input.deliveryKey),
          );
        } catch (error) {
          if (error instanceof ManualRunRejected) result = { status: error.code };
          else if (
            error instanceof DaemonDispatchFailure &&
            error.reason === "daemon_unreachable"
          ) {
            result = { status: "daemon_offline" };
          } else throw error;
        }
        return result;
      } catch (error) {
        return storageUnavailableOrThrow(error);
      }
    },
    async issueEnrollmentToken(authorization) {
      try {
        const token = randomBytes(32).toString("base64url");
        const expiresAt = new Date(clock.nowDate().getTime() + ENROLLMENT_LIFETIME_MS);
        const outcome = await repository.issueEnrollmentToken(authorization, { token, expiresAt });
        return outcome === "issued" ? { status: "issued", token, expiresAt } : { status: outcome };
      } catch (error) {
        return storageUnavailableOrThrow(error);
      }
    },
    async listRooms() {
      const authority = capabilities.roomAuthority;
      if (authority === undefined) return { status: "room_projection_unavailable" };
      try {
        const read = await authority.reader.listReadableRooms();
        return {
          status: "listed",
          rooms: read.value,
          ...projectionEnvelope(read, authority, clock),
        };
      } catch (error) {
        return storageUnavailableOrThrow(error);
      }
    },
    async getRoomSnapshot(_authorization, input) {
      const authority = capabilities.roomAuthority;
      if (authority === undefined) return { status: "room_projection_unavailable" };
      try {
        const snapshot = await authority.reader.readSnapshot(input.roomId);
        return {
          status: "ok",
          room: snapshot.value.room,
          participants: snapshot.value.participants,
          ...projectionEnvelope(snapshot, authority, clock),
        };
      } catch (error) {
        return roomReadErrorOrThrow(error);
      }
    },
    async replayRoomEvents(_authorization, input) {
      const authority = capabilities.roomAuthority;
      if (authority === undefined) return { status: "room_projection_unavailable" };
      try {
        const page = await authority.reader.replayEvents(input.roomId, input.after, input.limit);
        const lastSeq = page.value.events[page.value.events.length - 1]?.room_seq ?? input.after;
        return {
          status: "ok",
          room: page.value.room,
          events: page.value.events.map((event) => annotateEventFreshness(event, clock)),
          latest_seq: page.value.latestSeq,
          next_cursor: lastSeq,
          has_more: page.value.latestSeq > lastSeq,
          ...projectionEnvelope(page, authority, clock),
        };
      } catch (error) {
        return roomReadErrorOrThrow(error);
      }
    },
    // --- I4 Hub Control Contract V1 ---
    async resumeExecution(authorization, input) {
      try {
        return await invokeControlOperation(
          { repository, capabilities },
          authorization,
          "resume",
          input,
          async (target) => {
            if (target === undefined) return { status: "execution_not_found" };
            if (target.status === "spawning" || target.status === "running") {
              return {
                status: "control_precondition_failed",
                reason: "execution_already_live",
              };
            }
            return {
              status: "ok",
              durability: "recorded",
              effect: { executionStatus: target.status },
            };
          },
        );
      } catch (error) {
        return storageUnavailableOrThrow(error);
      }
    },
    async cancelExecution(authorization, input) {
      try {
        return await invokeControlOperation(
          { repository, capabilities },
          authorization,
          "cancel",
          input,
          async (target) => {
            if (target === undefined) return { status: "execution_not_found" };
            const updated = await repository.requestExecutionHubAction(
              authorization.organizationId,
              input.executionId,
              "interrupt",
            );
            if (updated === undefined) {
              // Lost-update race: a concurrent request with the same idempotency
              // key may have won the hub_action signal. Re-check the key before
              // reporting a precondition failure so the loser replays the
              // winner's op instead of 409ing on its own signal.
              const raced = await repository.findControlOperationByKey(
                authorization.organizationId,
                input.idempotencyKey,
              );
              if (raced !== undefined) {
                return { status: "replay_stored", existing: raced };
              }
              return {
                status: "control_precondition_failed",
                reason: "execution_not_live_or_action_pending",
              };
            }
            return {
              status: "ok",
              durability: "applied",
              effect: { previousHubAction: null, executionStatus: updated.status },
            };
          },
        );
      } catch (error) {
        return storageUnavailableOrThrow(error);
      }
    },
    async retryExecution(authorization, input) {
      try {
        return await invokeControlOperation(
          { repository, capabilities },
          authorization,
          "retry",
          input,
          async (target) => {
            if (target === undefined) return { status: "execution_not_found" };
            if (target.status === "spawning" || target.status === "running") {
              return {
                status: "control_precondition_failed",
                reason: "execution_still_live",
              };
            }
            return {
              status: "ok",
              durability: "recorded",
              effect: { fromStatus: target.status },
            };
          },
        );
      } catch (error) {
        return storageUnavailableOrThrow(error);
      }
    },
    async acknowledgeAttention(authorization, input) {
      try {
        const observedAt = clock.nowDate();
        return await invokeControlOperation(
          { repository, capabilities },
          authorization,
          "acknowledge",
          input,
          async (target) => {
            if (target === undefined) return { status: "execution_not_found" };
            if (input.attentionKind === "finish_execution_call") {
              return {
                status: "control_precondition_failed",
                reason: "finish_execution_call_is_daemon_side",
              };
            }
            const updated = await repository.recordExecutionHubAcknowledgement(
              authorization.organizationId,
              input.executionId,
              toHubAcknowledgement(input.attentionKind, observedAt),
            );
            if (updated === undefined) return { status: "execution_not_found" };
            return {
              status: "ok",
              durability: "applied",
              effect: {
                acknowledgement: {
                  kind: input.attentionKind,
                  observedAt: observedAt.toISOString(),
                },
              },
            };
          },
        );
      } catch (error) {
        return storageUnavailableOrThrow(error);
      }
    },
    async startApprovedExecution(authorization, input) {
      try {
        const issues = validateStartApprovedExecutionInput(input);
        if (issues.length > 0) return { status: "invalid_input", issues };
        const authority = resolveControlAuthority(capabilities);
        if (authority === undefined) return { status: "control_plane_unavailable" };
        const check = await checkControlCapability(authority, "execution_start");
        if (!check.allowed) {
          return { status: "control_capability_denied", capability: check.capability };
        }
        const organizationId = authorization.organizationId;
        const existing = await repository.findControlOperationByKey(
          organizationId,
          input.idempotencyKey,
        );
        if (existing !== undefined) {
          return replayOrConflict(existing, "execution_start", undefined);
        }
        const project = await repository.resolveManualRunProject(
          organizationId,
          input.trigger,
          input.projectSlug,
        );
        if (project === undefined) return { status: "project_not_found" };
        if (project.status === "disabled") return { status: "trigger_not_found" };
        const actor =
          typeof input.actor === "string" && input.actor.length > 0
            ? input.actor
            : authorization.credentialId;
        const deliveryKey = `control-${input.idempotencyKey}`;
        let dispatch: DispatchManualRunResult;
        try {
          dispatch = await dispatchManualRun(
            repository,
            capabilities,
            authorization,
            project.id,
            {
              projectSlug: input.projectSlug,
              expectedVersionId: input.expectedVersionId,
              trigger: input.trigger,
              actor,
              deliveryKey,
              input: input.input,
            },
            internalDeliveryId(organizationId, project.id, deliveryKey),
          );
        } catch (error) {
          if (error instanceof ManualRunRejected) {
            return { status: "control_precondition_failed", reason: error.code };
          }
          if (error instanceof DaemonDispatchFailure && error.reason === "daemon_unreachable") {
            return { status: "control_precondition_failed", reason: "daemon_offline" };
          }
          throw error;
        }
        if (dispatch.status === "invalid_input") return dispatch;
        if (dispatch.status !== "dispatched") {
          return { status: "control_precondition_failed", reason: dispatch.status };
        }
        const effect = {
          providerEventReceiptId: dispatch.providerEventReceiptId,
          triggerRunId: dispatch.triggerRunId,
          configuredTriggerName: dispatch.configuredTriggerName,
        };
        const { inserted, record } = await repository.insertControlOperation({
          organizationId,
          op: "execution_start",
          status: "applied",
          idempotencyKey: input.idempotencyKey,
          executionId: null,
          capability: controlCapabilityFor("execution_start"),
          subject: authority.reader.subjectLabel(),
          correlationId: input.correlationId ?? null,
          effect,
        });
        if (inserted) {
          return { status: "applied", operation: toControlOperationWire(record) };
        }
        return replayOrConflict(record, "execution_start", undefined);
      } catch (error) {
        return storageUnavailableOrThrow(error);
      }
    },
    async getControlOperation(authorization, input) {
      const authority = resolveControlAuthority(capabilities);
      if (authority === undefined) return { status: "control_plane_unavailable" };
      try {
        const record = await repository.findControlOperationById(
          authorization.organizationId,
          input.operationId,
        );
        if (record === undefined) return { status: "control_operation_not_found" };
        return { status: "ok", operation: toControlOperationWire(record) };
      } catch (error) {
        return storageUnavailableOrThrow(error);
      }
    },
    async listControlOperations(authorization, input) {
      const authority = resolveControlAuthority(capabilities);
      if (authority === undefined) return { status: "control_plane_unavailable" };
      try {
        const records = await repository.listControlOperations(authorization.organizationId, {
          ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
          ...(input.op === undefined ? {} : { op: input.op }),
          ...(input.status === undefined ? {} : { status: input.status }),
          limit: input.limit ?? 50,
        });
        return { status: "listed", operations: records.map(toControlOperationWire) };
      } catch (error) {
        return storageUnavailableOrThrow(error);
      }
    },
  };
}

/**
 * Envelope freshness for a projection response (I2/D5). `observed_at` passes
 * through the seam's observation stamp unchanged; `stale` is recomputed at
 * serve time against the seam's configured budget. An unparseable stamp is
 * reported stale — an observation we cannot date is never claimed fresh.
 */
function projectionEnvelope(
  read: ObservedRead<unknown>,
  authority: RoomAuthoritySource,
  clock: DaemonClock,
): { observed_at: string; stale: boolean } {
  const observedMs = Date.parse(read.observed_at);
  return {
    observed_at: read.observed_at,
    stale: Number.isNaN(observedMs)
      ? true
      : clock.nowDate().getTime() - observedMs > authority.staleAfterMs,
  };
}

/**
 * Serve-time freshness annotation for event kinds that carry an observation
 * contract — today `sieve.projection`, whose payload is
 * `{observed_at, source, digest, stale_after_ms}` (absolute-deadline
 * `stale_after` timestamps are also accepted). The stored event is never
 * mutated; this projects a computed view so the same event flips stale as it
 * ages. A projection event whose freshness cannot be evaluated is reported
 * stale — fail-honest, never silently fresh.
 */
function annotateEventFreshness(event: ProjectedRoomEvent, clock: DaemonClock): ProjectedRoomEvent {
  if (event.kind !== SIEVE_PROJECTION_EVENT_KIND) return event;
  return { ...event, freshness: sieveProjectionFreshness(event.payload, clock) };
}

function sieveProjectionFreshness(
  payload: Record<string, unknown>,
  clock: DaemonClock,
): EventFreshness {
  const observedRaw = payload["observed_at"];
  const observedMs = typeof observedRaw === "string" ? Date.parse(observedRaw) : Number.NaN;
  if (Number.isNaN(observedMs)) return { observed_at: null, stale: true };
  const deadlineMs = sieveStaleDeadlineMs(payload, observedMs);
  return {
    observed_at: new Date(observedMs).toISOString(),
    stale: deadlineMs === undefined ? true : clock.nowDate().getTime() > deadlineMs,
  };
}

/**
 * The writer-declared freshness deadline for a sieve.projection payload:
 * `stale_after_ms` (duration after observed_at, canonical) or `stale_after`
 * (absolute ISO timestamp, or a number treated as a duration for tolerance).
 */
function sieveStaleDeadlineMs(
  payload: Record<string, unknown>,
  observedMs: number,
): number | undefined {
  const duration = payload["stale_after_ms"] ?? payload["stale_after"];
  if (typeof duration === "number" && Number.isFinite(duration) && duration >= 0) {
    return observedMs + duration;
  }
  const absolute = payload["stale_after"];
  if (typeof absolute === "string") {
    const parsed = Date.parse(absolute);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

function roomReadErrorOrThrow(
  error: unknown,
):
  | { status: "room_not_found" }
  | { status: "capability_denied" }
  | { status: "infrastructure_unavailable" } {
  if (error instanceof RoomNotFoundError) return { status: "room_not_found" };
  if (error instanceof RoomCapabilityDeniedError) return { status: "capability_denied" };
  return storageUnavailableOrThrow(error);
}

function triggerCapability(capabilities: PublicOperationCapabilities, organizationId: string) {
  if (capabilities.triggerForOrganization === undefined) {
    throw new Error("organization triggers are unavailable");
  }
  return capabilities.triggerForOrganization(organizationId);
}

async function dispatchManualRun(
  repository: PublicOperationRepository,
  capabilities: PublicOperationCapabilities,
  authorization: {
    organizationId: string;
    kind: "apiKey" | "cliCredential";
    credentialId: string;
  },
  projectId: string,
  input: DispatchManualRunInput,
  deliveryId: string,
): Promise<DispatchManualRunResult> {
  const outcome = await capabilities.dispatchManualEvent({
    organizationId: authorization.organizationId,
    projectId,
    source: "manual.run",
    deliveryId,
    receivedAt: new Date(),
    payload: {
      ...(input.expectedVersionId === undefined
        ? {}
        : { expectedVersionId: input.expectedVersionId }),
      trigger: input.trigger,
      actor: input.actor,
      input: input.input,
      publicDeliveryKey: input.deliveryKey,
      authenticatedBy: {
        kind: authorization.kind === "apiKey" ? "api-key" : "cli-credential",
        credentialId: authorization.credentialId,
      },
    },
  });
  const providerEventReceiptId = outcome?.providerEventReceiptId;
  if (providerEventReceiptId === undefined) return { status: "dispatch_conflict" };
  const run = await repository.findManualRun(providerEventReceiptId, input.trigger);
  if (run === undefined) return { status: "dispatch_conflict" };
  if (run.outcome === "rejected") {
    return {
      status: "invalid_input",
      providerEventReceiptId,
      triggerRunId: run.id,
      configuredTriggerName: run.configuredTriggerName,
      issues: [{ path: ["input"], message: formatInvocationRejection(run.rejection) }],
    };
  }
  return {
    status: "dispatched",
    deliveryKey: input.deliveryKey,
    providerEventReceiptId,
    triggerRunId: run.id,
    configuredTriggerName: run.configuredTriggerName,
    workflowStatus: run.status,
  };
}

async function resolveConfigurationDeployment(
  repository: PublicOperationRepository,
  organizationId: string,
  input: {
    projectSlug?: string | undefined;
    files: readonly { path: string; content: string }[];
  },
  dryRun: boolean,
): Promise<
  | {
      success: true;
      files: readonly { path: string; content: string }[];
      target:
        | {
            status: "resolved";
            project: { id: string; slug: string };
            created: boolean;
          }
        | { status: "would_create"; projectSlug: string };
    }
  | {
      success: false;
      result:
        | { status: "project_not_found" }
        | {
            status: "invalid_bundle";
            issues: readonly { path: readonly (string | number)[]; message: string }[];
          };
    }
> {
  const explicitTarget =
    input.projectSlug === undefined
      ? undefined
      : await repository.resolveDeploymentProject({
          organizationId,
          explicitProjectSlug: input.projectSlug,
          dryRun,
        });
  if (explicitTarget?.status === "project_not_found") {
    return { success: false, result: explicitTarget };
  }

  let bundleName: string | undefined;
  try {
    const bundle = compileHubBundle(input.files);
    bundleName = bundle.name;
  } catch (error) {
    if (error instanceof HubBundleError) {
      return {
        success: false,
        result: { status: "invalid_bundle", issues: error.issues },
      };
    }
    throw error;
  }

  const target =
    explicitTarget ??
    (await repository.resolveDeploymentProject({
      organizationId,
      ...(bundleName === undefined ? {} : { bundleName }),
      dryRun,
    }));
  return target.status === "project_not_found"
    ? { success: false, result: target }
    : { success: true, files: input.files, target };
}

function internalDeliveryId(
  organizationId: string,
  projectId: string,
  deliveryKey: string,
): string {
  return `public-manual-${createHash("sha256")
    .update([organizationId, projectId, deliveryKey].map((part) => JSON.stringify(part)).join(":"))
    .digest("base64url")}`;
}

function storageUnavailableOrThrow(error: unknown): { status: "infrastructure_unavailable" } {
  if (isDatabaseUnavailableError(error)) return { status: "infrastructure_unavailable" };
  throw error;
}
