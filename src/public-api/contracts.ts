import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
  EXECUTION_ACTIONS,
  EXECUTION_STATES,
  EXECUTION_SUBSTATES,
} from "../execution-convergence/contract.js";
import {
  MAX_PROMPT_PARTIAL_CONTENT_BYTES,
  MAX_PROMPT_PARTIAL_COUNT,
  MAX_PROMPT_PARTIAL_PATH_LENGTH,
} from "../config/prompt-partials.js";

extendZodWithOpenApi(z);

export const FieldIssueSchema = z
  .object({
    path: z.array(z.union([z.string(), z.number().int()])),
    message: z.string(),
  })
  .strict()
  .openapi("FieldIssue", {
    example: { path: ["projectSlug"], message: "Required" },
  });

export const TriggerYamlRequestSchema = z
  .object({ yaml: z.string().min(1).max(1_000_000) })
  .strict()
  .openapi("TriggerYamlRequest", {
    description: "One self-contained Paseo trigger YAML document.",
  });

export const ValidatedTriggerSchema = z
  .object({ name: z.string(), valid: z.literal(true) })
  .strict()
  .openapi("ValidatedTrigger");

export const InstalledTriggerSchema = z
  .object({
    triggerId: z.string().uuid(),
    name: z.string(),
    revisionId: z.string().uuid(),
    version: z.number().int().positive(),
    active: z.literal(true),
  })
  .strict()
  .openapi("InstalledTrigger");

export const StartCliAuthorizationRequestSchema = z
  .object({})
  .strict()
  .openapi("StartCliAuthorizationRequest");

export const CliAuthorizationSchema = z
  .object({
    deviceCode: z.string(),
    userCode: z.string(),
    verificationUri: z.string().url(),
    verificationUriComplete: z.string().url(),
    expiresAt: z.string().datetime({ offset: true }),
    interval: z.number().int().positive(),
  })
  .strict()
  .openapi("CliAuthorization");

export const PollCliAuthorizationRequestSchema = z
  .object({ deviceCode: z.string().min(32).max(200) })
  .strict()
  .openapi("PollCliAuthorizationRequest");

export const CliAuthorizationPollSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        status: z.literal("authorized"),
        interval: z.number().int().positive(),
        credential: z.string().min(1),
        organizationId: z.string().min(1),
      })
      .strict(),
    z
      .object({
        status: z.enum(["pending", "slow_down", "denied", "expired", "disclosed"]),
        interval: z.number().int().positive(),
      })
      .strict(),
  ])
  .openapi("CliAuthorizationPoll");

export const ProblemSchema = z
  .object({
    type: z.string().url(),
    title: z.string(),
    status: z.number().int().min(400).max(599),
    detail: z.string(),
    code: z.string(),
    requestId: z.string(),
    issues: z.array(FieldIssueSchema).optional(),
  })
  .strict()
  .openapi("Problem", {
    example: {
      type: "https://paseo.sh/problems/invalid-request",
      title: "Invalid request",
      status: 400,
      detail: "The request body contains invalid fields.",
      code: "invalid_request",
      requestId: "5e967c44-fc22-4f6d-8fc5-1bbff33121af",
      issues: [{ path: ["projectSlug"], message: "Required" }],
    },
  });

export const ConfigurationFileSchema = z
  .object({
    path: z.string().min(1).max(MAX_PROMPT_PARTIAL_PATH_LENGTH),
    content: z.string().max(MAX_PROMPT_PARTIAL_CONTENT_BYTES),
  })
  .strict()
  .openapi("ConfigurationFile", {
    description: "One UTF-8 file in the canonical .paseo Hub bundle.",
    example: { path: ".paseo/hub.yml", content: "environments: {}\nagents: {}\n" },
  });

export const InstallConfigurationRequestSchema = z
  .object({
    projectSlug: z.string().trim().min(1).max(100).optional(),
    files: z.array(ConfigurationFileSchema).min(1).max(MAX_PROMPT_PARTIAL_COUNT),
  })
  .strict()
  .openapi("InstallConfigurationRequest", {
    description:
      "Install the complete canonical bundle: .paseo/hub.yml, direct-child .paseo/workflows/*.yml files, and referenced .paseo/workflows/partials/*.md files.",
    example: {
      projectSlug: "payments",
      files: [
        {
          path: ".paseo/hub.yml",
          content: [
            "name: payments",
            "environments:",
            "  runner:",
            "    kind: daemon",
            "    daemon: build-server",
            "    cwd: /workspace",
            "agents:",
            "  default:",
            "    provider: test",
          ].join("\n"),
        },
        {
          path: ".paseo/workflows/deploy.yml",
          content: [
            "name: deploy",
            "on: manual.run",
            "max_runtime: 1h",
            "steps:",
            "  - id: deploy",
            "    environment: runner",
            "    max_runtime: 30m",
            "    idle_timeout: 5m",
            "    agent: default",
            "    prompt:",
            "      - include: partials/safety.md",
          ].join("\n"),
        },
        {
          path: ".paseo/workflows/partials/safety.md",
          content: "Follow the safety checklist.",
        },
      ],
    },
  });

export const InstalledConfigurationSchema = z
  .object({
    projectSlug: z.string(),
    versionId: z.string().uuid(),
    version: z.number().int().positive(),
    active: z.literal(true),
  })
  .strict()
  .openapi("InstalledConfiguration", {
    example: {
      projectSlug: "payments",
      versionId: "84af3583-23ff-4fcc-9838-ed3262499be2",
      version: 4,
      active: true,
    },
  });

export const ValidatedConfigurationSchema = z
  .object({
    projectSlug: z.string(),
    valid: z.literal(true),
    wouldCreateProject: z.literal(true).optional(),
  })
  .strict()
  .openapi("ValidatedConfiguration", {
    example: { projectSlug: "payments", valid: true, wouldCreateProject: true },
  });

export const ProjectSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
  })
  .strict()
  .openapi("Project");

export const ProjectListSchema = z
  .object({ projects: z.array(ProjectSchema) })
  .strict()
  .openapi("ProjectList", {
    example: {
      projects: [
        {
          id: "84af3583-23ff-4fcc-9838-ed3262499be2",
          name: "Payments",
          slug: "payments",
        },
      ],
    },
  });

export const TriggerExportSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    enabled: z.boolean(),
    format: z.enum(["single_run", "legacy_multistep"]),
    yaml: z.string(),
  })
  .strict()
  .openapi("TriggerExport");

export const TriggerListSchema = z
  .object({ triggers: z.array(TriggerExportSchema) })
  .strict()
  .openapi("TriggerList");

export const ConfigurationResourcesSchema = z
  .object({
    daemons: z.array(z.object({ id: z.string().uuid(), slug: z.string() }).strict()),
    github: z.array(
      z
        .object({
          slug: z.string(),
          accountLogin: z.string(),
          accountType: z.string(),
          repositories: z.array(z.string()),
        })
        .strict(),
    ),
    discord: z.array(z.object({ slug: z.string(), guildName: z.string() }).strict()),
    slack: z.array(z.object({ slug: z.string(), teamName: z.string() }).strict()),
    linear: z.array(z.object({ slug: z.string(), organizationName: z.string() }).strict()),
  })
  .strict()
  .openapi("ConfigurationResources");

export const SetupResourcesSchema = z
  .object({
    github: z.array(
      z
        .object({
          slug: z.string(),
          accountLogin: z.string(),
          accountType: z.string(),
          repositories: z.array(z.string()),
        })
        .strict(),
    ),
    discord: z.array(z.object({ guildId: z.string(), guildName: z.string() }).strict()),
    slack: z.array(z.object({ teamId: z.string(), teamName: z.string() }).strict()),
  })
  .strict()
  .openapi("SetupResources");

export const DispatchManualRunRequestSchema = z
  .object({
    projectSlug: z.string().trim().min(1).max(100),
    expectedVersionId: z.string().uuid().optional(),
    trigger: z.string().trim().min(1).max(200),
    actor: z.string().trim().min(1).max(200),
    deliveryKey: z.string().trim().min(1).max(200),
    input: z.unknown(),
  })
  .strict()
  .openapi("DispatchManualRunRequest", {
    example: {
      projectSlug: "payments",
      trigger: "deploy",
      actor: "automation",
      deliveryKey: "deploy-2026-08-06",
      input: { environment: "production" },
    },
  });

export const DispatchedManualRunSchema = z
  .object({
    deliveryKey: z.string(),
    providerEventReceiptId: z.string().uuid(),
    triggerRunId: z.string().uuid(),
    configuredTriggerName: z.string(),
    workflowStatus: z.enum(["running", "succeeded", "failed", "timed_out"]),
  })
  .strict()
  .openapi("DispatchedManualRun", {
    example: {
      deliveryKey: "deploy-2026-08-06",
      providerEventReceiptId: "845e9d26-7977-45e1-bc69-d80a7b55a9cc",
      triggerRunId: "f83dc934-02a0-4849-8de7-699110be24ed",
      configuredTriggerName: "deploy",
      workflowStatus: "running",
    },
  });

export const EnrollmentTokenSchema = z
  .object({
    token: z.string().min(32),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .openapi("EnrollmentToken", {
    example: {
      token: "one-time-secret-returned-only-once",
      expiresAt: "2026-08-06T18:10:00.000Z",
    },
  });

// --- ANVIL Room read/projection (read seam over ANVIL/Postgres authority) ---
// Field names use the Foundation Interop V1 wire vocabulary (snake_case)
// because every value is authority-minted and passed through unchanged.

export const RoomIdParamsSchema = z.object({ roomId: z.string().uuid() }).openapi("RoomIdParams", {
  description: "Durable Room identity: anvil.rooms.public_id.",
});

export const RoomEventsQuerySchema = z
  .object({
    after: z.number().int().nonnegative().default(0).openapi({
      description:
        "Replay cursor: only committed events with room_seq greater than this value are returned. Reconnect by re-issuing your last seen room_seq.",
    }),
    limit: z.number().int().min(1).max(500).default(500).openapi({
      description: "Maximum events per page (1–500, default 500).",
    }),
  })
  .openapi("RoomEventsQuery");

/** Runtime route input (path params + query arrive as strings → coerce). */
export const RoomSnapshotInputSchema = z.object({ roomId: z.string().uuid() });

export const RoomEventsInputSchema = z.object({
  roomId: z.string().uuid(),
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(500).default(500),
});

export const ProjectedRoomSchema = z
  .object({
    room_id: z.string().uuid(),
    project_ref: z.string().nullable(),
    status: z.enum(["active", "archived", "closed"]),
    correlation_id: z.string().uuid(),
    latest_seq: z.number().int().nonnegative(),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict()
  .openapi("ProjectedRoom", {
    description:
      "Projection of anvil.rooms. latest_seq is the committed high-water room_seq (0 when empty); room_id/correlation_id are authority-minted.",
  });

export const ProjectedRoomParticipantSchema = z
  .object({
    participant_id: z.string().uuid(),
    agent_id: z.string().uuid(),
    role: z.string(),
    joined_seq: z.number().int().positive().nullable(),
    acked_seq: z.number().int().nonnegative(),
    joined_at: z.string().datetime({ offset: true }),
  })
  .strict()
  .openapi("ProjectedRoomParticipant", {
    description:
      "Active anvil.room_participants period. agent_id is the durable anvil.agents.public_id — a participant is an agent, never a session.",
  });

export const EventFreshnessSchema = z
  .object({
    observed_at: z.string().datetime({ offset: true }).nullable(),
    stale: z.boolean(),
  })
  .strict()
  .openapi("EventFreshness", {
    description:
      "Hub-computed freshness for event kinds carrying an observation contract (sieve.projection). observed_at is the writer's stamp; stale is recomputed at serve time and flips true once the observation outlives its declared budget. Null observed_at means the writer's stamp was unparseable; such events always report stale.",
  });

export const ProjectedRoomEventSchema = z
  .object({
    event_id: z.string().uuid(),
    room_id: z.string().uuid(),
    room_seq: z.number().int().positive(),
    kind: z.string().openapi({
      description:
        "Authority-minted event kind, passed through unchanged (e.g. message, handoff, sieve.projection, execution.transition). The taxonomy is owned by the authority plane and grows; the projection never rejects an unknown kind.",
    }),
    producer: z.string(),
    payload: z.record(z.string(), z.unknown()),
    link: z.record(z.string(), z.unknown()),
    correlation_id: z.string().uuid(),
    causation_id: z.string().nullable(),
    task_ref: z.string().uuid().nullable(),
    campaign_id: z.string().nullable(),
    idempotency_key: z.string(),
    occurred_at: z.string().datetime({ offset: true }).nullable(),
    created_at: z.string().datetime({ offset: true }),
    freshness: EventFreshnessSchema.optional(),
  })
  .strict()
  .openapi("ProjectedRoomEvent", {
    description:
      "One committed anvil.room_events row. room_seq is the canonical replay cursor (authority-assigned, per-room monotonic; gaps are legal). (room_id, room_seq) is the projection dedupe key.",
  });

const ProjectionEnvelopeShape = {
  observed_at: z.string().datetime({ offset: true }).openapi({
    description:
      "When the authority state backing this response was observed by the projection seam. Never a client stamp.",
  }),
  stale: z.boolean().openapi({
    description:
      "True when now - observed_at exceeds the projection freshness budget. Stale responses are last-known projections, never authority claims.",
  }),
} as const;

export const RoomListSchema = z
  .object({ rooms: z.array(ProjectedRoomSchema), ...ProjectionEnvelopeShape })
  .strict()
  .openapi("RoomList", {
    description: "Rooms the Hub instance's bound ANVIL subject may read.",
  });

export const RoomSnapshotSchema = z
  .object({
    room: ProjectedRoomSchema,
    participants: z.array(ProjectedRoomParticipantSchema),
    ...ProjectionEnvelopeShape,
  })
  .strict()
  .openapi("RoomSnapshot");

export const RoomEventPageSchema = z
  .object({
    room: ProjectedRoomSchema,
    events: z.array(ProjectedRoomEventSchema),
    latest_seq: z.number().int().nonnegative(),
    next_cursor: z.number().int().nonnegative(),
    has_more: z.boolean(),
    ...ProjectionEnvelopeShape,
  })
  .strict()
  .openapi("RoomEventPage", {
    description:
      "Deterministic replay page: events with room_seq > the request cursor, ascending. Re-issue next_cursor as `after` to continue; identical cursors replay identical sequences.",
  });

// --- I4 Hub Control Contract V1 (control plane over the Room authority seam) ---
// Field names use the Hub Public API camelCase convention; the `control.*`
// ANVIL capability is checked server-side per op — the transport scope only
// selects the HTTP surface, never the authority.

export const ControlOpSchema = z
  .enum(["resume", "cancel", "retry", "acknowledge", "execution_start"])
  .openapi("ControlOp", {
    description:
      "The I4 control operation. resume/retry record durable authorized intent (materialized by I3); cancel applies a durable interrupt signal; acknowledge records a client-side attention state; execution_start dispatches an approved manual run.",
  });

export const ControlOperationStatusSchema = z
  .enum(["recorded", "applied"])
  .openapi("ControlOperationStatus", {
    description:
      "recorded: the authorized intent was durably recorded for later materialization. applied: a Hub-owned effect was durably applied.",
  });

export const ControlOperationSchema = z
  .object({
    operationId: z.string().uuid(),
    op: ControlOpSchema,
    status: ControlOperationStatusSchema,
    replayed: z.literal(true).optional(),
    idempotencyKey: z.string(),
    executionId: z.string().uuid().nullable(),
    capability: z.string(),
    subject: z.string(),
    correlationId: z.string().nullable(),
    effect: z.unknown(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .openapi("ControlOperation", {
    description:
      "One recorded I4 control operation. capability is the ANVIL capability that authorized it (control.<op>); subject is the bound ANVIL subject label in producer form. effect is per-op (see the frozen contract).",
  });

export const ControlIdempotencyBodySchema = z
  .object({
    idempotencyKey: z.string().min(1).max(64).openapi({
      description:
        "REQUIRED idempotency key (1–64 chars). Re-issuing the same key returns the stored operation with replayed:true; a different op under a used key is a 409.",
    }),
    correlationId: z.string().min(1).optional().openapi({ description: "I1 spine passthrough." }),
  })
  .strict();

export const ControlExecutionIdParamsSchema = z
  .object({ executionId: z.string().uuid() })
  .openapi("ControlExecutionIdParams", {
    description: "Target execution: the agent_executions durable id.",
  });

/** Runtime route input for the execution-targeted POST ops (path param arrives as string). */
export const ExecutionControlInputSchema = z.object({
  executionId: z.string().uuid(),
  idempotencyKey: z.string().min(1).max(64),
  correlationId: z.string().min(1).optional(),
});

export const AcknowledgeAttentionInputSchema = z.object({
  executionId: z.string().uuid(),
  attentionKind: z.enum(["terminal", "idle", "finish_execution_call"]).openapi({
    description:
      "terminal/idle record a client-side attention state. finish_execution_call is daemon-side only and is rejected.",
  }),
  idempotencyKey: z.string().min(1).max(64),
  correlationId: z.string().min(1).optional(),
});

/** JSON body for POST /controls/executions/{executionId}/acknowledge. */
export const AcknowledgeAttentionRequestSchema = ControlIdempotencyBodySchema.extend({
  attentionKind: z.enum(["terminal", "idle", "finish_execution_call"]).openapi({
    description:
      "terminal/idle record a client-side attention state. finish_execution_call is daemon-side only and is rejected with 409.",
  }),
}).openapi("AcknowledgeAttentionRequest");

export const StartApprovedExecutionRequestSchema = ControlIdempotencyBodySchema.extend({
  trigger: z.string().min(1).openapi({ description: "Manual trigger name to dispatch." }),
  projectSlug: z.string().min(1).openapi({ description: "Target project slug." }),
  input: z.unknown().optional().openapi({ description: "Trigger input payload." }),
  actor: z.string().min(1).optional().openapi({
    description: "Optional actor label; defaults to the calling credential id.",
  }),
  expectedVersionId: z.string().uuid().optional().openapi({
    description: "Fail closed unless this configuration version is active.",
  }),
}).openapi("StartApprovedExecutionRequest");

export const ControlOperationIdParamsSchema = z
  .object({ operationId: z.string().uuid() })
  .openapi("ControlOperationIdParams", { description: "Durable control operation id." });

/** Runtime route input for GET /controls/operations/{operationId}. */
export const GetControlOperationInputSchema = z.object({ operationId: z.string().uuid() });

export const ControlOperationsQuerySchema = z
  .object({
    executionId: z.string().uuid().optional().openapi({
      description: "Filter to operations targeting this execution.",
    }),
    op: ControlOpSchema.optional().openapi({ description: "Filter by control op." }),
    status: ControlOperationStatusSchema.optional().openapi({
      description: "Filter by recorded/applied.",
    }),
    limit: z.number().int().min(1).max(200).default(50).openapi({
      description: "Maximum operations returned (1–200, default 50).",
    }),
  })
  .openapi("ControlOperationsQuery");

/** Runtime route input for GET /controls/operations (query arrives as strings → coerce). */
export const ListControlOperationsInputSchema = z.object({
  executionId: z.string().uuid().optional(),
  op: z.enum(["resume", "cancel", "retry", "acknowledge", "execution_start"]).optional(),
  status: z.enum(["recorded", "applied"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const ControlOperationResponseSchema = z
  .object({ operation: ControlOperationSchema })
  .strict()
  .openapi("ControlOperationResponse", {
    description:
      "The recorded (or replayed) control operation. replayed:true is present only on idempotent replay.",
  });

export const ControlOperationListSchema = z
  .object({ operations: z.array(ControlOperationSchema) })
  .strict()
  .openapi("ControlOperationList", {
    description: "Control operations, newest first.",
  });
// --- I4 capability-scoped execution control (ANVIL authority vocabulary) ---
// Path params are Hub routing vocabulary (camelCase); request/response fields
// are authority-minted and keep the Foundation wire form (snake_case).

export const ExecutionIdParamsSchema = z
  .object({ executionId: z.string().uuid() })
  .openapi("ExecutionIdParams", {
    description: "Durable execution identity: anvil.execution_bindings.execution_id.",
  });

export const ExecutionActionSchema = z.enum(EXECUTION_ACTIONS).openapi("ExecutionAction", {
  description:
    "Capability-scoped control action. Each maps to the authority capability execution.<action>.",
});

export const ExecutionActionParamsSchema = z
  .object({ executionId: z.string().uuid(), action: ExecutionActionSchema })
  .openapi("ExecutionActionParams");

/** Runtime route input for execution routes (path params only). */
export const ExecutionRouteSchema = z.object({ executionId: z.string().uuid() });
export const ExecutionActionRouteSchema = z.object({
  executionId: z.string().uuid(),
  action: z.enum(EXECUTION_ACTIONS),
});

export const MintExecutionGrantRequestSchema = z
  .object({
    action: ExecutionActionSchema,
    ttl_seconds: z.coerce.number().int().min(1).max(3600).default(300).openapi({
      description: "Grant lifetime in seconds (default 300, max 3600).",
    }),
  })
  .strict()
  .openapi("MintExecutionGrantRequest");

export const MintedExecutionGrantSchema = z
  .object({
    grant_id: z.string().uuid(),
    execution_id: z.string().uuid(),
    action: ExecutionActionSchema,
    principal: z.string().openapi({
      description:
        "The principal the grant is bound to (v1: device:hub-credential:<credentialId>). Presenting it under another credential is capability_denied.",
    }),
    issued_at: z.string().datetime({ offset: true }),
    expires_at: z.string().datetime({ offset: true }),
    scope_hash: z.string().openapi({
      description:
        "sha256 over grant_id|execution_id|action|principal|issued_at|expires_at — advisory; the durable grant row is authoritative.",
    }),
  })
  .strict()
  .openapi("MintedExecutionGrant");

export const ControlExecutionRequestSchema = z
  .object({
    grant_id: z.string().uuid().openapi({
      description:
        "A Hub-minted capability grant for (this execution, this action, your principal).",
    }),
    request_id: z.string().min(1).max(200).optional().openapi({
      description:
        "Opaque caller idempotency discriminator; required only to re-acknowledge an execution with a fresh acknowledge grant.",
    }),
  })
  .strict()
  .openapi("ControlExecutionRequest");

/**
 * Merged route+body inputs parsed inside `invoke` — the executor applies each
 * schema separately; these re-parse the merged object once for the operation.
 */
export const MintExecutionGrantInputSchema = z.object({
  executionId: z.string().uuid(),
  action: z.enum(EXECUTION_ACTIONS),
  ttl_seconds: z.coerce.number().int().min(1).max(3600).default(300),
});

export const ControlExecutionInputSchema = z.object({
  executionId: z.string().uuid(),
  action: z.enum(EXECUTION_ACTIONS),
  grant_id: z.string().uuid(),
  request_id: z.string().min(1).max(200).optional(),
});

export const ExecutionStateWireSchema = z.enum(EXECUTION_STATES).openapi("ExecutionState", {
  description:
    "Durable ANVIL execution lifecycle state (synthesized Hub-side, persisted to authority). Never Paseo's native agent status.",
});

export const ExecutionSubstateWireSchema = z
  .enum(EXECUTION_SUBSTATES)
  .nullable()
  .openapi("ExecutionSubstate");

export const ExecutionActionOutcomeSchema = z
  .object({
    execution_id: z.string().uuid(),
    state: ExecutionStateWireSchema,
    substate: ExecutionSubstateWireSchema,
    room_seq: z.number().int().positive().openapi({
      description: "Authority-assigned room_seq of the committed execution.transition event.",
    }),
    event_id: z.string().uuid(),
    duplicate: z.boolean().openapi({
      description:
        "True when the same (execution, action, grant) was already committed; room_seq/event_id identify the original commit.",
    }),
    effect_applied: z.boolean().openapi({
      description:
        "False when the authority transition committed but the Hub/daemon-side effect could not be applied (e.g. no live daemon to interrupt).",
    }),
    retry_execution_id: z.string().uuid().optional().openapi({
      description: "For retry: the deterministic id of the new attempt execution.",
    }),
  })
  .strict()
  .openapi("ExecutionActionOutcome");

export const ExecutionDescriptionSchema = z
  .object({
    execution_id: z.string().uuid(),
    room_id: z.string().uuid(),
    correlation_id: z.string().uuid(),
    state: ExecutionStateWireSchema,
    substate: ExecutionSubstateWireSchema,
    last_transition: z
      .object({
        room_seq: z.number().int().positive(),
        event_id: z.string().uuid(),
        occurred_at: z.string().datetime({ offset: true }).nullable(),
        causation_id: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .openapi("ExecutionDescription");

export type Problem = z.infer<typeof ProblemSchema>;
