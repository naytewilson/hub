import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { z } from "zod";
import type {
  AcceptedTriggerRunRecord,
  AgentExecutionRecord,
  ControlOperationRecord,
  InsertControlOperationInput,
} from "../db/types.js";
import { CONTROL_CAPABILITIES, type RoomAuthoritySource } from "../room-projection/index.js";
import { createPublicOperations } from "./index.js";
import type {
  ControlExecutionResult,
  PublicAuthorization,
  PublicOperationCapabilities,
  PublicOperationRepository,
} from "./types.js";

const ORG = "organization-1";
const OTHER_ORG = "organization-2";
const EXECUTION_ID = "845e9d26-7977-45e1-bc69-d80a7b55a9cc";

const authorization: PublicAuthorization = {
  kind: "apiKey",
  credentialId: "key-1",
  organizationId: ORG,
  scopes: ["controls:operate", "controls:read"],
};

function baseExecution(overrides: Partial<AgentExecutionRecord> = {}): AgentExecutionRecord {
  return {
    id: EXECUTION_ID,
    organizationId: ORG,
    projectId: "project-1",
    machineId: null,
    status: "running",
    startedAt: new Date("2026-09-15T00:00:00.000Z"),
    completedAt: null,
    completedByAgentAt: null,
    deadlineAt: null,
    idleDeadlineAt: null,
    result: null,
    triggerContext: {},
    outputContext: {},
    reactionState: null,
    configurationRevisionId: "revision-1",
    completionTokenHash: null,
    replyClaimedAt: null,
    replyClaimCount: 0,
    outputEmissions: {},
    outputDeliveryAttempts: {},
    launchIntent: null,
    daemonId: null,
    daemonAgentId: null,
    workflowStepRunId: null,
    hubAction: null,
    hubActionCompletedAt: null,
    hubActionReadyAt: null,
    hubActionAcknowledgements: { terminalAt: null, idleAt: null, finishExecutionCall: null },
    ...overrides,
  };
}

function acceptedRun(): AcceptedTriggerRunRecord {
  const now = new Date("2026-09-15T00:00:00.000Z");
  return {
    id: "run-1",
    organizationId: ORG,
    projectId: "project-1",
    configurationRevisionId: "revision-1",
    providerEventReceiptId: "receipt-1",
    configuredTriggerName: "manual",
    prompt: "",
    inputs: {},
    values: {},
    triggerContext: {},
    outputContext: {},
    createdAt: now,
    outcome: "accepted",
    status: "running",
    deadlineAt: now,
    deadlineKind: null,
    failureReason: null,
    reactionState: null,
    terminalNotificationPendingAt: null,
    terminalNotificationDeliveredAt: null,
    terminalNotificationLeaseExpiresAt: null,
    completedAt: null,
  };
}

interface ControlTestRepository extends PublicOperationRepository {
  executions: Map<string, AgentExecutionRecord>;
  opsById: Map<string, ControlOperationRecord>;
  hubActionRequests: string[];
  acknowledgementRequests: string[];
  projects: Map<string, { id: string; disabled: boolean }>;
  dispatchInputs: unknown[];
  dispatchedReceiptId: string | undefined;
}

/** In-memory repository mirroring the tightened I4 semantics (null-only guard, unique key backstop). */
function makeRepository(): ControlTestRepository {
  const executions = new Map<string, AgentExecutionRecord>();
  const opsById = new Map<string, ControlOperationRecord>();
  const opsByKey = new Map<string, ControlOperationRecord>();
  const hubActionRequests: string[] = [];
  const acknowledgementRequests: string[] = [];
  const projects = new Map<string, { id: string; disabled: boolean }>();
  const dispatchInputs: unknown[] = [];
  const insertControlOperationRecord = (
    input: InsertControlOperationInput,
  ): { inserted: boolean; record: ControlOperationRecord } => {
    const key = `${input.organizationId}:${input.idempotencyKey}`;
    const existing = opsByKey.get(key);
    if (existing !== undefined) return { inserted: false, record: existing };
    const record: ControlOperationRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      op: input.op,
      status: input.status,
      idempotencyKey: input.idempotencyKey,
      executionId: input.executionId ?? null,
      capability: input.capability,
      subject: input.subject,
      correlationId: input.correlationId ?? null,
      effect: input.effect ?? null,
      response: input.response ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    opsByKey.set(key, record);
    opsById.set(record.id, record);
    return { inserted: true, record };
  };
  const repo: ControlTestRepository = {
    executions,
    opsById,
    hubActionRequests,
    acknowledgementRequests,
    projects,
    dispatchInputs,
    dispatchedReceiptId: "receipt-1",
    listActiveProjects: () => Promise.reject(new Error("not used")),
    listConfigurationResources: () => Promise.reject(new Error("not used")),
    listSetupResources: () => Promise.reject(new Error("not used")),
    resolveManualRunProject: (organizationId, triggerName, projectSlug) => {
      const project = projects.get(`${organizationId}:${triggerName}:${projectSlug}`);
      if (project === undefined) return Promise.resolve(undefined);
      return Promise.resolve(
        project.disabled
          ? { status: "disabled" as const }
          : { status: "resolved" as const, id: project.id },
      );
    },
    resolveDeploymentProject: () => Promise.reject(new Error("not used")),
    findManualRun: (providerEventReceiptId) =>
      Promise.resolve(providerEventReceiptId === "receipt-1" ? acceptedRun() : undefined),
    issueEnrollmentToken: () => Promise.reject(new Error("not used")),
    findAgentExecution: (organizationId, executionId) => {
      const execution = executions.get(executionId);
      if (execution === undefined || execution.organizationId !== organizationId) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve({ ...execution });
    },
    requestExecutionHubAction: (organizationId, executionId, action) => {
      hubActionRequests.push(`${organizationId}:${executionId}:${action}`);
      const execution = executions.get(executionId);
      if (execution === undefined || execution.organizationId !== organizationId) {
        return Promise.resolve(undefined);
      }
      if (execution.status !== "spawning" && execution.status !== "running") {
        return Promise.resolve(undefined);
      }
      // I4 cancel requires NO pending hub action at all.
      if (execution.hubAction !== null) return Promise.resolve(undefined);
      const updated = {
        ...execution,
        hubAction: action,
        hubActionReadyAt: null,
        hubActionCompletedAt: null,
      };
      executions.set(executionId, updated);
      return Promise.resolve(updated);
    },
    recordExecutionHubAcknowledgement: (organizationId, executionId, acknowledgement) => {
      acknowledgementRequests.push(`${organizationId}:${executionId}:${acknowledgement.kind}`);
      const execution = executions.get(executionId);
      if (execution === undefined || execution.organizationId !== organizationId) {
        return Promise.resolve(undefined);
      }
      let key: "terminalAt" | "idleAt" | null = null;
      if (acknowledgement.kind === "terminal") {
        key = "terminalAt";
      } else if (acknowledgement.kind === "idle") {
        key = "idleAt";
      }
      const updated: AgentExecutionRecord =
        key === null
          ? execution
          : {
              ...execution,
              hubActionAcknowledgements: {
                ...execution.hubActionAcknowledgements,
                [key]: acknowledgement.observedAt,
              },
            };
      executions.set(executionId, updated);
      return Promise.resolve(updated);
    },
    applyCancelControlOperation: (input) => {
      const existing = opsByKey.get(`${input.organizationId}:${input.idempotencyKey}`);
      if (existing !== undefined) {
        return Promise.resolve({ status: "existing" as const, record: existing });
      }
      hubActionRequests.push(`${input.organizationId}:${input.executionId}:interrupt`);
      const execution = executions.get(input.executionId);
      if (execution === undefined || execution.organizationId !== input.organizationId) {
        return Promise.resolve({ status: "execution_not_found" as const });
      }
      if (
        (execution.status !== "spawning" && execution.status !== "running") ||
        execution.hubAction !== null
      ) {
        return Promise.resolve({ status: "precondition_failed" as const });
      }
      executions.set(input.executionId, {
        ...execution,
        hubAction: "interrupt",
        hubActionReadyAt: null,
        hubActionCompletedAt: null,
      });
      const committed = insertControlOperationRecord({
        organizationId: input.organizationId,
        op: "cancel",
        status: "applied",
        idempotencyKey: input.idempotencyKey,
        executionId: input.executionId,
        capability: input.capability,
        subject: input.subject,
        correlationId: input.correlationId ?? null,
        effect: { previousHubAction: null, executionStatus: execution.status },
      });
      return Promise.resolve(
        committed.inserted
          ? { status: "applied" as const, record: committed.record }
          : { status: "existing" as const, record: committed.record },
      );
    },
    applyAcknowledgementControlOperation: (input) => {
      const existing = opsByKey.get(`${input.organizationId}:${input.idempotencyKey}`);
      if (existing !== undefined) {
        return Promise.resolve({ status: "existing" as const, record: existing });
      }
      acknowledgementRequests.push(
        `${input.organizationId}:${input.executionId}:${input.acknowledgement.kind}`,
      );
      const execution = executions.get(input.executionId);
      if (execution === undefined || execution.organizationId !== input.organizationId) {
        return Promise.resolve({ status: "execution_not_found" as const });
      }
      const acknowledgements = { ...execution.hubActionAcknowledgements };
      if (input.acknowledgement.kind === "terminal") {
        if (
          acknowledgements.terminalAt === null ||
          input.acknowledgement.observedAt.getTime() > acknowledgements.terminalAt.getTime()
        ) {
          acknowledgements.terminalAt = input.acknowledgement.observedAt;
        }
      } else if (
        acknowledgements.idleAt === null ||
        input.acknowledgement.observedAt.getTime() > acknowledgements.idleAt.getTime()
      ) {
        acknowledgements.idleAt = input.acknowledgement.observedAt;
      }
      executions.set(input.executionId, {
        ...execution,
        hubActionAcknowledgements: acknowledgements,
      });
      const committed = insertControlOperationRecord({
        organizationId: input.organizationId,
        op: "acknowledge",
        status: "applied",
        idempotencyKey: input.idempotencyKey,
        executionId: input.executionId,
        capability: input.capability,
        subject: input.subject,
        correlationId: input.correlationId ?? null,
        effect: {
          acknowledgement: {
            kind: input.acknowledgement.kind,
            observedAt: input.acknowledgement.observedAt.toISOString(),
          },
        },
      });
      return Promise.resolve(
        committed.inserted
          ? { status: "applied" as const, record: committed.record }
          : { status: "existing" as const, record: committed.record },
      );
    },
    insertControlOperation: (input: InsertControlOperationInput) =>
      Promise.resolve(insertControlOperationRecord(input)),
    findControlOperationById: (organizationId, id) => {
      const record = opsById.get(id);
      if (record === undefined || record.organizationId !== organizationId) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve(record);
    },
    findControlOperationByKey: (organizationId, idempotencyKey) => {
      return Promise.resolve(opsByKey.get(`${organizationId}:${idempotencyKey}`));
    },
    listControlOperations: (organizationId, filter) => {
      const records = [...opsById.values()]
        .filter((record) => record.organizationId === organizationId)
        .filter(
          (record) => filter.executionId === undefined || record.executionId === filter.executionId,
        )
        .filter((record) => filter.op === undefined || record.op === filter.op)
        .filter((record) => filter.status === undefined || record.status === filter.status)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
        .slice(0, filter.limit);
      return Promise.resolve(records);
    },
  };
  return repo;
}

function makeAuthority(grants: ReadonlySet<string>): RoomAuthoritySource {
  const unimplemented = () => Promise.reject(new Error("not used by control operations"));
  return {
    subject: { kind: "device", subjectRef: "machine:test" },
    reader: {
      subjectLabel: () => "machine:test",
      holdsCapability: (capability: string, scopeRoomPublicId: string | null) =>
        Promise.resolve(scopeRoomPublicId === null && grants.has(capability)),
      listReadableRooms: unimplemented,
      readSnapshot: unimplemented,
      replayEvents: unimplemented,
    },
    staleAfterMs: 60_000,
    close: () => Promise.resolve(),
  };
}

const ALL_CONTROL_CAPABILITIES = new Set<string>(Object.values(CONTROL_CAPABILITIES));

function baseCapabilities(): PublicOperationCapabilities {
  const unused = () => Promise.reject(new Error("control operations do not use this capability"));
  return {
    configurationForProject: () => ({
      validateBundle: unused,
      insertManualBundleRevision: unused,
      activate: unused,
    }),
    validateBundleForOrganization: unused,
    dispatchManualEvent: () => Promise.resolve({ providerEventReceiptId: "receipt-1" }),
  };
}

describe("control operations", () => {
  it("fails new mutations closed without ANVIL while keeping the Hub ledger readable", async () => {
    const repository = makeRepository();
    const operations = createPublicOperations(repository, baseCapabilities());
    assert.deepEqual(
      await operations.resumeExecution(authorization, {
        executionId: EXECUTION_ID,
        idempotencyKey: "k",
      }),
      {
        status: "control_plane_unavailable",
      },
    );
    assert.deepEqual(
      await operations.cancelExecution(authorization, {
        executionId: EXECUTION_ID,
        idempotencyKey: "k",
      }),
      {
        status: "control_plane_unavailable",
      },
    );
    assert.deepEqual(
      await operations.retryExecution(authorization, {
        executionId: EXECUTION_ID,
        idempotencyKey: "k",
      }),
      {
        status: "control_plane_unavailable",
      },
    );
    assert.deepEqual(
      await operations.acknowledgeAttention(authorization, {
        executionId: EXECUTION_ID,
        attentionKind: "idle",
        idempotencyKey: "k",
      }),
      { status: "control_plane_unavailable" },
    );
    assert.deepEqual(
      await operations.startApprovedExecution(authorization, {
        idempotencyKey: "k",
        trigger: "manual",
        projectSlug: "project",
      }),
      { status: "control_plane_unavailable" },
    );
    assert.deepEqual(
      await operations.getControlOperation(authorization, { operationId: randomUUID() }),
      { status: "control_operation_not_found" },
    );
    assert.deepEqual(await operations.listControlOperations(authorization, { limit: 10 }), {
      status: "listed",
      operations: [],
    });
    assert.equal(repository.hubActionRequests.length, 0);
  });

  it("replays stored mutations while the ANVIL authority seam is unavailable", async () => {
    const repository = makeRepository();
    const existingCancel = await repository.insertControlOperation({
      organizationId: ORG,
      op: "cancel",
      status: "applied",
      idempotencyKey: "offline-replay",
      executionId: EXECUTION_ID,
      capability: "control.cancel",
      subject: "machine:test",
      effect: { previousHubAction: null, executionStatus: "running" },
    });
    const existingStart = await repository.insertControlOperation({
      organizationId: ORG,
      op: "execution_start",
      status: "applied",
      idempotencyKey: "offline-start-replay",
      executionId: null,
      capability: "control.execution_start",
      subject: "machine:test",
      effect: {
        requestTarget: {
          trigger: "manual",
          projectSlug: "project",
          expectedVersionId: null,
        },
      },
    });
    const operations = createPublicOperations(repository, baseCapabilities());

    const cancelReplay = await operations.cancelExecution(authorization, {
      executionId: EXECUTION_ID,
      idempotencyKey: "offline-replay",
    });
    assert.equal(cancelReplay.status, "replayed");
    if (cancelReplay.status !== "replayed") throw new Error("unreachable");
    assert.equal(cancelReplay.operation.operationId, existingCancel.record.id);
    assert.equal(cancelReplay.operation.replayed, true);
    assert.equal(repository.hubActionRequests.length, 0);

    const startReplay = await operations.startApprovedExecution(authorization, {
      idempotencyKey: "offline-start-replay",
      trigger: "manual",
      projectSlug: "project",
    });
    assert.equal(startReplay.status, "replayed");
    if (startReplay.status !== "replayed") throw new Error("unreachable");
    assert.equal(startReplay.operation.operationId, existingStart.record.id);
    assert.equal(repository.dispatchInputs.length, 0);

    const got = await operations.getControlOperation(authorization, {
      operationId: existingCancel.record.id,
    });
    assert.equal(got.status, "ok");
    const listed = await operations.listControlOperations(authorization, { limit: 10 });
    assert.equal(listed.status, "listed");
    if (listed.status !== "listed") throw new Error("unreachable");
    assert.equal(listed.operations.length, 2);
  });

  it("denies every op when the bound ANVIL subject lacks the durable grant — transport scope is not authority", async () => {
    const repository = makeRepository();
    repository.executions.set(EXECUTION_ID, baseExecution());
    const operations = createPublicOperations(repository, {
      ...baseCapabilities(),
      roomAuthority: makeAuthority(new Set()),
    });
    // authorization carries controls:operate — the ANVIL capability check must still fail.
    const makeNonStartInvoke = (
      op: "resume" | "cancel" | "retry" | "acknowledge",
    ): (() => Promise<ControlExecutionResult>) => {
      if (op === "acknowledge") {
        return () =>
          operations.acknowledgeAttention(authorization, {
            executionId: EXECUTION_ID,
            attentionKind: "idle",
            idempotencyKey: `k-${op}`,
          });
      }
      return () =>
        operations[`${op}Execution`](authorization, {
          executionId: EXECUTION_ID,
          idempotencyKey: `k-${op}`,
        });
    };
    for (const [op, capability] of [
      ["resume", CONTROL_CAPABILITIES.resume],
      ["cancel", CONTROL_CAPABILITIES.cancel],
      ["retry", CONTROL_CAPABILITIES.retry],
      ["acknowledge", CONTROL_CAPABILITIES.acknowledge],
      ["execution_start", CONTROL_CAPABILITIES.executionStart],
    ] as const) {
      const invoke: () => Promise<{ status: string }> =
        op === "execution_start"
          ? () =>
              operations.startApprovedExecution(authorization, {
                idempotencyKey: `k-${op}`,
                trigger: "manual",
                projectSlug: "project",
              })
          : makeNonStartInvoke(op);
      assert.deepEqual(await invoke(), { status: "control_capability_denied", capability }, op);
    }
    assert.equal(repository.hubActionRequests.length, 0);
    assert.equal(repository.opsById.size, 0);
  });

  it("cancel applies a durable interrupt on a live execution with no pending action", async () => {
    const repository = makeRepository();
    repository.executions.set(EXECUTION_ID, baseExecution());
    const operations = createPublicOperations(repository, {
      ...baseCapabilities(),
      roomAuthority: makeAuthority(ALL_CONTROL_CAPABILITIES),
    });
    const result = await operations.cancelExecution(authorization, {
      executionId: EXECUTION_ID,
      idempotencyKey: "cancel-1",
    });
    assert.equal(result.status, "applied");
    if (result.status !== "applied") throw new Error("unreachable");
    assert.equal(result.operation.op, "cancel");
    assert.equal(result.operation.capability, "control.cancel");
    assert.equal(result.operation.subject, "machine:test");
    assert.equal(repository.executions.get(EXECUTION_ID)?.hubAction, "interrupt");
  });

  it("cancel fails closed when any hub action is already pending", async () => {
    for (const pending of ["interrupt", "archive"] as const) {
      const repository = makeRepository();
      repository.executions.set(EXECUTION_ID, baseExecution({ hubAction: pending }));
      const operations = createPublicOperations(repository, {
        ...baseCapabilities(),
        roomAuthority: makeAuthority(ALL_CONTROL_CAPABILITIES),
      });
      assert.deepEqual(
        await operations.cancelExecution(authorization, {
          executionId: EXECUTION_ID,
          idempotencyKey: `cancel-${pending}`,
        }),
        { status: "control_precondition_failed", reason: "execution_not_live_or_action_pending" },
        pending,
      );
      // The pending action is never clobbered.
      assert.equal(repository.executions.get(EXECUTION_ID)?.hubAction, pending);
    }
  });

  it("cancel replays the winner when it loses the hub_action update race", async () => {
    const repository = makeRepository();
    // Simulate the race winner: hub_action already set and the op recorded.
    repository.executions.set(EXECUTION_ID, baseExecution({ hubAction: "interrupt" }));
    const winner = await repository.insertControlOperation({
      organizationId: ORG,
      op: "cancel",
      status: "applied",
      idempotencyKey: "cancel-race",
      executionId: EXECUTION_ID,
      capability: "control.cancel",
      subject: "machine:test",
    });
    assert.equal(winner.inserted, true);
    const operations = createPublicOperations(repository, {
      ...baseCapabilities(),
      roomAuthority: makeAuthority(ALL_CONTROL_CAPABILITIES),
    });
    const result = await operations.cancelExecution(authorization, {
      executionId: EXECUTION_ID,
      idempotencyKey: "cancel-race",
    });
    assert.equal(result.status, "replayed");
    if (result.status !== "replayed") throw new Error("unreachable");
    assert.equal(result.operation.operationId, winner.record.id);
    assert.equal(result.operation.replayed, true);
    // The pending interrupt is never clobbered by the loser.
    assert.equal(repository.executions.get(EXECUTION_ID)?.hubAction, "interrupt");
  });

  it("cancel rejects terminal and unknown executions without touching the ledger", async () => {
    const repository = makeRepository();
    repository.executions.set(EXECUTION_ID, baseExecution({ status: "failed" }));
    const operations = createPublicOperations(repository, {
      ...baseCapabilities(),
      roomAuthority: makeAuthority(ALL_CONTROL_CAPABILITIES),
    });
    assert.deepEqual(
      await operations.cancelExecution(authorization, {
        executionId: EXECUTION_ID,
        idempotencyKey: "cancel-terminal",
      }),
      { status: "control_precondition_failed", reason: "execution_not_live_or_action_pending" },
    );
    assert.deepEqual(
      await operations.cancelExecution(authorization, {
        executionId: randomUUID(),
        idempotencyKey: "cancel-unknown",
      }),
      { status: "execution_not_found" },
    );
    assert.equal(repository.opsById.size, 0);
  });

  it("scopes execution targets and operations to the calling organization", async () => {
    const repository = makeRepository();
    repository.executions.set(EXECUTION_ID, baseExecution({ organizationId: OTHER_ORG }));
    const operations = createPublicOperations(repository, {
      ...baseCapabilities(),
      roomAuthority: makeAuthority(ALL_CONTROL_CAPABILITIES),
    });
    assert.deepEqual(
      await operations.cancelExecution(authorization, {
        executionId: EXECUTION_ID,
        idempotencyKey: "cancel-cross-org",
      }),
      { status: "execution_not_found" },
    );

    repository.executions.set(EXECUTION_ID, baseExecution());
    const applied = await operations.cancelExecution(authorization, {
      executionId: EXECUTION_ID,
      idempotencyKey: "cancel-org",
    });
    assert.equal(applied.status, "applied");
    if (applied.status !== "applied") throw new Error("unreachable");
    const otherOrgAuth: PublicAuthorization = { ...authorization, organizationId: OTHER_ORG };
    assert.deepEqual(
      await operations.getControlOperation(otherOrgAuth, {
        operationId: applied.operation.operationId,
      }),
      { status: "control_operation_not_found" },
    );
    const listed = await operations.listControlOperations(otherOrgAuth, { limit: 10 });
    assert.equal(listed.status, "listed");
    if (listed.status !== "listed") throw new Error("unreachable");
    assert.equal(listed.operations.length, 0);
  });

  it("replays a used idempotency key without re-executing the effect", async () => {
    const repository = makeRepository();
    repository.executions.set(EXECUTION_ID, baseExecution());
    const operations = createPublicOperations(repository, {
      ...baseCapabilities(),
      roomAuthority: makeAuthority(ALL_CONTROL_CAPABILITIES),
    });
    const first = await operations.cancelExecution(authorization, {
      executionId: EXECUTION_ID,
      idempotencyKey: "replay-key",
    });
    assert.equal(first.status, "applied");
    if (first.status !== "applied") throw new Error("unreachable");
    const second = await operations.cancelExecution(authorization, {
      executionId: EXECUTION_ID,
      idempotencyKey: "replay-key",
    });
    assert.equal(second.status, "replayed");
    if (second.status !== "replayed") throw new Error("unreachable");
    assert.equal(second.operation.operationId, first.operation.operationId);
    assert.equal(second.operation.replayed, true);
    // The durable interrupt was requested exactly once — no double effect.
    assert.equal(repository.hubActionRequests.length, 1);
    assert.equal(repository.opsById.size, 1);
  });

  it("conflicts when a used idempotency key is presented for a different op", async () => {
    const repository = makeRepository();
    repository.executions.set(EXECUTION_ID, baseExecution({ status: "failed" }));
    const operations = createPublicOperations(repository, {
      ...baseCapabilities(),
      roomAuthority: makeAuthority(ALL_CONTROL_CAPABILITIES),
    });
    const recorded = await operations.retryExecution(authorization, {
      executionId: EXECUTION_ID,
      idempotencyKey: "shared-key",
    });
    assert.equal(recorded.status, "recorded");
    if (recorded.status !== "recorded") throw new Error("unreachable");
    assert.deepEqual(
      await operations.resumeExecution(authorization, {
        executionId: EXECUTION_ID,
        idempotencyKey: "shared-key",
      }),
      {
        status: "idempotency_key_conflict",
        existingOperationId: recorded.operation.operationId,
      },
    );
    // Same key under the SAME op and execution still replays.
    const replay = await operations.retryExecution(authorization, {
      executionId: EXECUTION_ID,
      idempotencyKey: "shared-key",
    });
    assert.equal(replay.status, "replayed");
  });

  it("resume and retry record intent only from failed executions", async () => {
    const repository = makeRepository();
    repository.executions.set(EXECUTION_ID, baseExecution({ status: "running" }));
    const operations = createPublicOperations(repository, {
      ...baseCapabilities(),
      roomAuthority: makeAuthority(ALL_CONTROL_CAPABILITIES),
    });
    assert.deepEqual(
      await operations.retryExecution(authorization, {
        executionId: EXECUTION_ID,
        idempotencyKey: "retry-live",
      }),
      { status: "control_precondition_failed", reason: "execution_not_failed" },
    );
    repository.executions.set(EXECUTION_ID, baseExecution({ status: "failed" }));
    const retry = await operations.retryExecution(authorization, {
      executionId: EXECUTION_ID,
      idempotencyKey: "retry-1",
    });
    assert.equal(retry.status, "recorded");
    if (retry.status !== "recorded") throw new Error("unreachable");
    assert.equal(retry.operation.op, "retry");
    // Recorded intent does not rematerialize the execution.
    assert.equal(repository.executions.get(EXECUTION_ID)?.status, "failed");
    assert.equal(repository.executions.get(EXECUTION_ID)?.hubAction, null);

    repository.executions.set(EXECUTION_ID, baseExecution({ status: "succeeded" }));
    assert.deepEqual(
      await operations.resumeExecution(authorization, {
        executionId: EXECUTION_ID,
        idempotencyKey: "resume-succeeded",
      }),
      { status: "control_precondition_failed", reason: "execution_not_failed" },
    );
    assert.deepEqual(
      await operations.retryExecution(authorization, {
        executionId: EXECUTION_ID,
        idempotencyKey: "retry-succeeded",
      }),
      { status: "control_precondition_failed", reason: "execution_not_failed" },
    );
  });

  it("acknowledge applies terminal/idle and rejects the daemon-side kind", async () => {
    const repository = makeRepository();
    repository.executions.set(EXECUTION_ID, baseExecution());
    const operations = createPublicOperations(repository, {
      ...baseCapabilities(),
      roomAuthority: makeAuthority(ALL_CONTROL_CAPABILITIES),
    });
    const idle = await operations.acknowledgeAttention(authorization, {
      executionId: EXECUTION_ID,
      attentionKind: "idle",
      idempotencyKey: "ack-idle",
    });
    assert.equal(idle.status, "applied");
    assert.notEqual(
      repository.executions.get(EXECUTION_ID)?.hubActionAcknowledgements.idleAt,
      null,
    );
    assert.deepEqual(
      await operations.acknowledgeAttention(authorization, {
        executionId: EXECUTION_ID,
        attentionKind: "finish_execution_call",
        idempotencyKey: "ack-finish",
      }),
      {
        status: "control_precondition_failed",
        reason: "finish_execution_call_is_daemon_side",
      },
    );
    // Rejected kinds are never recorded.
    assert.equal(repository.opsById.size, 1);
  });

  it("conflicts when an acknowledge key is reused for a different attention target", async () => {
    const repository = makeRepository();
    repository.executions.set(EXECUTION_ID, baseExecution());
    const operations = createPublicOperations(repository, {
      ...baseCapabilities(),
      roomAuthority: makeAuthority(ALL_CONTROL_CAPABILITIES),
    });

    const first = await operations.acknowledgeAttention(authorization, {
      executionId: EXECUTION_ID,
      attentionKind: "idle",
      idempotencyKey: "ack-target-key",
    });
    assert.equal(first.status, "applied");
    if (first.status !== "applied") throw new Error("unreachable");

    assert.deepEqual(
      await operations.acknowledgeAttention(authorization, {
        executionId: EXECUTION_ID,
        attentionKind: "terminal",
        idempotencyKey: "ack-target-key",
      }),
      {
        status: "idempotency_key_conflict",
        existingOperationId: first.operation.operationId,
      },
    );
    assert.equal(repository.acknowledgementRequests.length, 1);
  });

  it("startApprovedExecution fails closed on project, trigger, and dispatch problems", async () => {
    const repository = makeRepository();
    const operations = createPublicOperations(repository, {
      ...baseCapabilities(),
      roomAuthority: makeAuthority(ALL_CONTROL_CAPABILITIES),
    });
    const start = (input: {
      idempotencyKey: string;
      trigger: string;
      projectSlug: string;
      actor?: string;
    }) => operations.startApprovedExecution(authorization, input);

    assert.deepEqual(
      await start({ idempotencyKey: "s1", trigger: "manual", projectSlug: "missing" }),
      { status: "project_not_found" },
    );
    repository.projects.set(`${ORG}:manual:project`, { id: "project-1", disabled: true });
    assert.deepEqual(
      await start({ idempotencyKey: "s2", trigger: "manual", projectSlug: "project" }),
      { status: "trigger_not_found" },
    );
    repository.projects.set(`${ORG}:manual:project`, { id: "project-1", disabled: false });
    repository.dispatchedReceiptId = undefined;
    const noDispatch = createPublicOperations(repository, {
      ...baseCapabilities(),
      dispatchManualEvent: () => Promise.resolve(undefined),
      roomAuthority: makeAuthority(ALL_CONTROL_CAPABILITIES),
    });
    assert.deepEqual(
      await noDispatch.startApprovedExecution(authorization, {
        idempotencyKey: "s3",
        trigger: "manual",
        projectSlug: "project",
      }),
      { status: "control_precondition_failed", reason: "dispatch_conflict" },
    );
    assert.equal(repository.opsById.size, 0);
  });

  it("startApprovedExecution dispatches with the idempotency-derived delivery key and records the op", async () => {
    const repository = makeRepository();
    repository.projects.set(`${ORG}:manual:project`, { id: "project-1", disabled: false });
    const operations = createPublicOperations(repository, {
      ...baseCapabilities(),
      dispatchManualEvent: (input) => {
        repository.dispatchInputs.push(input);
        return Promise.resolve({ providerEventReceiptId: "receipt-1" });
      },
      roomAuthority: makeAuthority(ALL_CONTROL_CAPABILITIES),
    });
    const result = await operations.startApprovedExecution(authorization, {
      idempotencyKey: "start-key",
      trigger: "manual",
      projectSlug: "project",
      input: { reason: "approved" },
    });
    assert.equal(result.status, "applied");
    if (result.status !== "applied") throw new Error("unreachable");
    assert.equal(result.operation.op, "execution_start");
    assert.equal(result.operation.executionId, null);
    const effect = z
      .object({
        providerEventReceiptId: z.string(),
        triggerRunId: z.string(),
        configuredTriggerName: z.string(),
      })
      .parse(result.operation.effect);
    assert.equal(effect.providerEventReceiptId, "receipt-1");
    assert.equal(effect.triggerRunId, "run-1");
    assert.equal(effect.configuredTriggerName, "manual");
    assert.equal(
      Object.prototype.hasOwnProperty.call(result.operation.effect, "requestTarget"),
      false,
    );
    const stored = repository.opsById.get(result.operation.operationId);
    assert.ok(stored);
    assert.ok(
      typeof stored.effect === "object" && stored.effect !== null && !Array.isArray(stored.effect),
    );
    assert.ok("requestTarget" in stored.effect);
    assert.deepEqual(stored.effect["requestTarget"], {
      trigger: "manual",
      projectSlug: "project",
      expectedVersionId: null,
    });
    const dispatch = z
      .object({ payload: z.object({ publicDeliveryKey: z.string() }) })
      .parse(repository.dispatchInputs[0]);
    assert.equal(dispatch.payload.publicDeliveryKey, "control-start-key");
    // A replayed key returns the recorded dispatch instead of dispatching again.
    const replayed = await operations.startApprovedExecution(authorization, {
      idempotencyKey: "start-key",
      trigger: "manual",
      projectSlug: "project",
    });
    assert.equal(replayed.status, "replayed");
    assert.equal(repository.dispatchInputs.length, 1);

    const changedTarget = await operations.startApprovedExecution(authorization, {
      idempotencyKey: "start-key",
      trigger: "other-manual",
      projectSlug: "other-project",
    });
    assert.deepEqual(changedTarget, {
      status: "idempotency_key_conflict",
      existingOperationId: result.operation.operationId,
    });
    assert.equal(repository.dispatchInputs.length, 1);
  });

  it("recovers approved-start after dispatch committed but control receipt persistence failed", async () => {
    const repository = makeRepository();
    repository.projects.set(`${ORG}:manual:project`, { id: "project-1", disabled: false });
    const durableInsert = repository.insertControlOperation;
    let failReceiptOnce = true;
    repository.insertControlOperation = async (input) => {
      if (failReceiptOnce) {
        failReceiptOnce = false;
        throw new Error("injected control receipt persistence failure");
      }
      return durableInsert(input);
    };
    const operations = createPublicOperations(repository, {
      ...baseCapabilities(),
      dispatchManualEvent: (input) => {
        repository.dispatchInputs.push(input);
        // The manual trigger plane is independently idempotent on deliveryId:
        // retrying the same control key resolves the same persisted receipt/run.
        return Promise.resolve({ providerEventReceiptId: "receipt-1" });
      },
      roomAuthority: makeAuthority(ALL_CONTROL_CAPABILITIES),
    });

    await assert.rejects(
      () =>
        operations.startApprovedExecution(authorization, {
          idempotencyKey: "start-crash-window",
          trigger: "manual",
          projectSlug: "project",
        }),
      /injected control receipt persistence failure/u,
    );
    assert.equal(repository.opsById.size, 0);

    const recovered = await operations.startApprovedExecution(authorization, {
      idempotencyKey: "start-crash-window",
      trigger: "manual",
      projectSlug: "project",
    });
    assert.equal(recovered.status, "applied");
    assert.equal(repository.opsById.size, 1);
    assert.equal(repository.dispatchInputs.length, 2);

    const deliveries = repository.dispatchInputs.map(
      (input) =>
        z.object({ payload: z.object({ publicDeliveryKey: z.string() }) }).parse(input).payload
          .publicDeliveryKey,
    );
    assert.deepEqual(deliveries, ["control-start-crash-window", "control-start-crash-window"]);
  });

  it("rejects invalid inputs before any effect", async () => {
    const repository = makeRepository();
    const operations = createPublicOperations(repository, {
      ...baseCapabilities(),
      roomAuthority: makeAuthority(ALL_CONTROL_CAPABILITIES),
    });
    const result = await operations.cancelExecution(authorization, {
      executionId: EXECUTION_ID,
      idempotencyKey: "",
    });
    assert.equal(result.status, "invalid_input");
    assert.equal(repository.hubActionRequests.length, 0);
    assert.equal(repository.opsById.size, 0);
  });

  it("lists recorded operations with filters, newest first", async () => {
    const repository = makeRepository();
    repository.executions.set(EXECUTION_ID, baseExecution({ status: "failed" }));
    const operations = createPublicOperations(repository, {
      ...baseCapabilities(),
      roomAuthority: makeAuthority(ALL_CONTROL_CAPABILITIES),
    });
    await operations.retryExecution(authorization, {
      executionId: EXECUTION_ID,
      idempotencyKey: "list-1",
    });
    await operations.resumeExecution(authorization, {
      executionId: EXECUTION_ID,
      idempotencyKey: "list-2",
    });
    const listed = await operations.listControlOperations(authorization, { limit: 10 });
    assert.equal(listed.status, "listed");
    if (listed.status !== "listed") throw new Error("unreachable");
    assert.deepEqual(listed.operations.map((op) => op.op).sort(), ["resume", "retry"]);
    const filtered = await operations.listControlOperations(authorization, {
      op: "retry",
      limit: 10,
    });
    assert.equal(filtered.status, "listed");
    if (filtered.status !== "listed") throw new Error("unreachable");
    assert.equal(filtered.operations.length, 1);
    const byId = await operations.getControlOperation(authorization, {
      operationId: listed.operations[0]!.operationId,
    });
    assert.equal(byId.status, "ok");
    assert.deepEqual(
      await operations.getControlOperation(authorization, { operationId: randomUUID() }),
      { status: "control_operation_not_found" },
    );
  });

  it("survives an operations restart: recorded ops stay readable from the shared repository", async () => {
    const repository = makeRepository();
    repository.executions.set(EXECUTION_ID, baseExecution({ status: "failed" }));
    const first = createPublicOperations(repository, {
      ...baseCapabilities(),
      roomAuthority: makeAuthority(ALL_CONTROL_CAPABILITIES),
    });
    const recorded = await first.retryExecution(authorization, {
      executionId: EXECUTION_ID,
      idempotencyKey: "restart-1",
    });
    assert.equal(recorded.status, "recorded");
    if (recorded.status !== "recorded") throw new Error("unreachable");

    // A fresh operations instance over the same durable repository (the restart).
    const second = createPublicOperations(repository, {
      ...baseCapabilities(),
      roomAuthority: makeAuthority(ALL_CONTROL_CAPABILITIES),
    });
    const got = await second.getControlOperation(authorization, {
      operationId: recorded.operation.operationId,
    });
    assert.equal(got.status, "ok");
    if (got.status !== "ok") throw new Error("unreachable");
    assert.equal(got.operation.idempotencyKey, "restart-1");
    // The replay path still works after the restart.
    const replay = await second.retryExecution(authorization, {
      executionId: EXECUTION_ID,
      idempotencyKey: "restart-1",
    });
    assert.equal(replay.status, "replayed");
  });
});
