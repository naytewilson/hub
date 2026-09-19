import type { z } from "zod";
import type { ApiKeyScope } from "../auth/api-key-contract.js";
import type {
  ControlExecutionOperationResult,
  ControlExecutionResult,
  DispatchManualRunResult,
  GetControlOperationResult,
  GetExecutionResult,
  GetRoomSnapshotResult,
  InstallConfigurationResult,
  InstallTriggerResult,
  IssueEnrollmentTokenResult,
  ListControlOperationsResult,
  ListConfigurationResourcesResult,
  ListRoomsResult,
  ListSetupResourcesResult,
  ListProjectsResult,
  ListTriggersResult,
  MintExecutionGrantResult,
  PublicOperations,
  ReplayRoomEventsResult,
  StartApprovedExecutionResult,
  ValidateConfigurationResult,
  ValidateTriggerResult,
} from "../public-operations/index.js";
import {
  AcknowledgeAttentionInputSchema,
  AcknowledgeAttentionRequestSchema,
  ControlExecutionIdParamsSchema,
  ControlExecutionInputSchema,
  ControlExecutionRequestSchema,
  ControlIdempotencyBodySchema,
  ControlOperationIdParamsSchema,
  ControlOperationListSchema,
  ControlOperationResponseSchema,
  ControlOperationsQuerySchema,
  DispatchManualRunRequestSchema,
  DispatchedManualRunSchema,
  EnrollmentTokenSchema,
  ExecutionActionOutcomeSchema,
  ExecutionActionParamsSchema,
  ExecutionActionRouteSchema,
  ExecutionControlInputSchema,
  ExecutionDescriptionSchema,
  ExecutionIdParamsSchema,
  ExecutionRouteSchema,
  GetControlOperationInputSchema,
  InstallConfigurationRequestSchema,
  InstalledConfigurationSchema,
  InstalledTriggerSchema,
  ListControlOperationsInputSchema,
  MintedExecutionGrantSchema,
  MintExecutionGrantInputSchema,
  MintExecutionGrantRequestSchema,
  ProjectListSchema,
  RoomEventsInputSchema,
  RoomEventsQuerySchema,
  RoomEventPageSchema,
  RoomIdParamsSchema,
  RoomListSchema,
  RoomSnapshotInputSchema,
  RoomSnapshotSchema,
  StartApprovedExecutionRequestSchema,
  TriggerListSchema,
  ConfigurationResourcesSchema,
  SetupResourcesSchema,
  ValidatedConfigurationSchema,
  TriggerYamlRequestSchema,
  ValidatedTriggerSchema,
} from "./contracts.js";

export type PublicOperationId =
  | "listTriggers"
  | "validateTrigger"
  | "installTrigger"
  | "listProjects"
  | "listConfigurationResources"
  | "listSetupResources"
  | "validateConfiguration"
  | "installConfiguration"
  | "dispatchManualRun"
  | "issueEnrollmentToken"
  | "listRooms"
  | "getRoomSnapshot"
  | "replayRoomEvents"
  | "resumeExecution"
  | "cancelExecution"
  | "retryExecution"
  | "acknowledgeAttention"
  | "startApprovedExecution"
  | "getControlOperation"
  | "listControlOperations"
  | "getExecution"
  | "mintExecutionGrant"
  | "controlExecution";

export interface PublicOperationDefinition {
  id: PublicOperationId;
  method: "get" | "post";
  /** Route template; `{name}` segments become captured path parameters. */
  path: string;
  scope: ApiKeyScope;
  /** JSON body schema (POST operations). */
  requestSchema?: z.ZodType;
  /**
   * Route input schema for parameterized GET routes: validates the merged
   * `{...pathParams, ...queryParams}` object before the operation runs.
   */
  routeSchema?: z.ZodType;
  /** OpenAPI-only path-parameter schema for `{name}` segments. */
  paramsSchema?: z.ZodObject;
  /** OpenAPI-only query-parameter schema. */
  querySchema?: z.ZodObject;
  successSchema: z.ZodType;
  successStatus: 200 | 201 | 202;
  resultMapping:
    | "trigger-validation"
    | "triggers"
    | "trigger-installation"
    | "projects"
    | "configuration-resources"
    | "setup-resources"
    | "validation"
    | "configuration"
    | "manual-run"
    | "enrollment-token"
    | "rooms"
    | "room-snapshot"
    | "room-events"
    | "control"
    | "control-list"
    | "execution"
    | "execution-grant"
    | "execution-action";
  summary: string;
  description: string;
  tag:
    | "Triggers"
    | "Projects"
    | "Configurations"
    | "Runs"
    | "Daemons"
    | "Rooms"
    | "Controls"
    | "Executions";
  responses: Readonly<Record<number, string>>;
  invoke(
    operations: PublicOperations,
    authorization: Parameters<PublicOperations["issueEnrollmentToken"]>[0],
    input: unknown,
  ): Promise<
    | ListProjectsResult
    | ListTriggersResult
    | ValidateTriggerResult
    | InstallTriggerResult
    | ListConfigurationResourcesResult
    | ListSetupResourcesResult
    | ValidateConfigurationResult
    | InstallConfigurationResult
    | DispatchManualRunResult
    | IssueEnrollmentTokenResult
    | ListRoomsResult
    | GetRoomSnapshotResult
    | ReplayRoomEventsResult
    | ControlExecutionResult
    | StartApprovedExecutionResult
    | GetControlOperationResult
    | ListControlOperationsResult
    | GetExecutionResult
    | MintExecutionGrantResult
    | ControlExecutionOperationResult
  >;
}

export const publicOperationManifest: readonly PublicOperationDefinition[] = [
  {
    id: "listTriggers",
    method: "get",
    path: "/api/v1/triggers",
    scope: "configuration:validate",
    successSchema: TriggerListSchema,
    successStatus: 200,
    resultMapping: "triggers",
    summary: "List triggers",
    description: "Lists active organization triggers with their deployable YAML documents.",
    tag: "Triggers",
    responses: {
      200: "The organization's active trigger documents.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks configuration:validate.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication or storage is unavailable.",
    },
    invoke: (operations, authorization) => operations.listTriggers(authorization),
  },
  {
    id: "validateTrigger",
    method: "post",
    path: "/api/v1/triggers/validate",
    scope: "configuration:validate",
    requestSchema: TriggerYamlRequestSchema,
    successSchema: ValidatedTriggerSchema,
    successStatus: 200,
    resultMapping: "trigger-validation",
    summary: "Validate one trigger",
    description: "Validates one self-contained trigger against organization resources.",
    tag: "Triggers",
    responses: {
      200: "The trigger is valid.",
      400: "The JSON request is malformed.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks configuration:validate.",
      422: "The trigger YAML or referenced organization resource is invalid.",
      503: "Hub authentication or storage is unavailable.",
    },
    invoke: (operations, authorization, input) =>
      operations.validateTrigger(authorization, TriggerYamlRequestSchema.parse(input)),
  },
  {
    id: "installTrigger",
    method: "post",
    path: "/api/v1/triggers/install",
    scope: "configuration:install",
    requestSchema: TriggerYamlRequestSchema,
    successSchema: InstalledTriggerSchema,
    successStatus: 201,
    resultMapping: "trigger-installation",
    summary: "Install one trigger",
    description: "Creates or replaces an organization trigger by its YAML name.",
    tag: "Triggers",
    responses: {
      201: "The trigger revision is active.",
      400: "The JSON request is malformed.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks configuration:install.",
      422: "The trigger YAML or referenced organization resource is invalid.",
      503: "Hub authentication or storage is unavailable.",
    },
    invoke: (operations, authorization, input) =>
      operations.installTrigger(authorization, TriggerYamlRequestSchema.parse(input)),
  },
  {
    id: "listProjects",
    method: "get",
    path: "/api/v1/projects",
    scope: "projects:read",
    successSchema: ProjectListSchema,
    successStatus: 200,
    resultMapping: "projects",
    summary: "List projects",
    description: "Lists active projects in the authenticated organization.",
    tag: "Projects",
    responses: {
      200: "The organization's active projects.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks projects:read.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication or storage is unavailable.",
    },
    invoke: (operations, authorization) => operations.listProjects(authorization),
  },
  {
    id: "listConfigurationResources",
    method: "get",
    path: "/api/v1/configuration-resources",
    scope: "configuration:validate",
    successSchema: ConfigurationResourcesSchema,
    successStatus: 200,
    resultMapping: "configuration-resources",
    summary: "List configuration resources",
    description:
      "Lists organization daemon and provider slugs that configuration validation resolves.",
    tag: "Configurations",
    responses: {
      200: "The organization's configuration resources.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks configuration:validate.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication or storage is unavailable.",
    },
    invoke: (operations, authorization) => operations.listConfigurationResources(authorization),
  },
  {
    id: "listSetupResources",
    method: "get",
    path: "/api/v1/setup-resources",
    scope: "configuration:validate",
    successSchema: SetupResourcesSchema,
    successStatus: 200,
    resultMapping: "setup-resources",
    summary: "List setup resources",
    description:
      "Lists provider-native identifiers and labels needed to author starter workflow filters.",
    tag: "Configurations",
    responses: {
      200: "The organization's setup resources.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks configuration:validate.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication or storage is unavailable.",
    },
    invoke: (operations, authorization) => operations.listSetupResources(authorization),
  },
  {
    id: "validateConfiguration",
    method: "post",
    path: "/api/v1/configurations/validate",
    scope: "configuration:validate",
    requestSchema: InstallConfigurationRequestSchema,
    successSchema: ValidatedConfigurationSchema,
    successStatus: 200,
    resultMapping: "validation",
    summary: "Validate configuration",
    description:
      "Resolves the deployment project and validates the same YAML, prompt-partial bundle, daemon, and provider resources as installation without creating a project, recording a revision, or changing active configuration.",
    tag: "Configurations",
    responses: {
      200: "The configuration is valid for the project.",
      400: "The JSON request is malformed or has invalid fields.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks configuration:validate.",
      404: "The project does not exist in the credential's organization.",
      422: "The YAML, supplied prompt partial bundle, or Hub configuration is invalid.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication or storage is unavailable.",
    },
    invoke: (operations, authorization, input) =>
      operations.validateConfiguration(
        authorization,
        InstallConfigurationRequestSchema.parse(input),
      ),
  },
  {
    id: "installConfiguration",
    method: "post",
    path: "/api/v1/configurations/install",
    scope: "configuration:install",
    requestSchema: InstallConfigurationRequestSchema,
    successSchema: InstalledConfigurationSchema,
    successStatus: 201,
    resultMapping: "configuration",
    summary: "Install and activate configuration",
    description:
      "Resolves or creates the deployment project, validates the complete canonical Hub bundle, records a configuration revision, and atomically activates it.",
    tag: "Configurations",
    responses: {
      201: "The new configuration revision is active.",
      400: "The JSON request is malformed or has invalid fields.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks configuration:install.",
      404: "The project does not exist in the credential's organization.",
      422: "The YAML, supplied prompt partial bundle, or Hub configuration is invalid.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication or storage is unavailable.",
    },
    invoke: (operations, authorization, input) =>
      operations.installConfiguration(
        authorization,
        InstallConfigurationRequestSchema.parse(input),
      ),
  },
  {
    id: "dispatchManualRun",
    method: "post",
    path: "/api/v1/manual-runs",
    scope: "runs:dispatch",
    requestSchema: DispatchManualRunRequestSchema,
    successSchema: DispatchedManualRunSchema,
    successStatus: 200,
    resultMapping: "manual-run",
    summary: "Dispatch a manual run",
    description:
      "Uses deliveryKey as caller-supplied request identity in the existing durable manual-event path.",
    tag: "Runs",
    responses: {
      200: "The durable manual event resolved to a run.",
      400: "The JSON request or trigger input is invalid.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks runs:dispatch or the actor is forbidden.",
      404: "The project, configuration, or manual trigger does not exist.",
      409: "The existing manual event path could not resolve a run.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication or storage is unavailable.",
    },
    invoke: (operations, authorization, input) =>
      operations.dispatchManualRun(authorization, DispatchManualRunRequestSchema.parse(input)),
  },
  {
    id: "issueEnrollmentToken",
    method: "post",
    path: "/api/v1/daemons/enrollment-tokens",
    scope: "daemons:enroll",
    successSchema: EnrollmentTokenSchema,
    successStatus: 201,
    resultMapping: "enrollment-token",
    summary: "Issue a daemon enrollment token",
    description: "Returns a short-lived, single-use token for enrolling one daemon.",
    tag: "Daemons",
    responses: {
      201: "A short-lived enrollment token was issued.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks daemons:enroll.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication or storage is unavailable.",
    },
    invoke: (operations, authorization) => operations.issueEnrollmentToken(authorization),
  },
  {
    id: "listRooms",
    method: "get",
    path: "/api/v1/rooms",
    scope: "rooms:read",
    successSchema: RoomListSchema,
    successStatus: 200,
    resultMapping: "rooms",
    summary: "List readable Rooms",
    description:
      "Lists ANVIL Rooms the Hub instance's bound ANVIL subject may read (a durable global or room-scoped room.read grant in anvil.capability_grants). Projection only — Room state is owned by ANVIL authority; Hub never mints room identities. Every response carries `observed_at` (when the authority state was observed) and `stale` (true once that observation outlives its freshness budget).",
    tag: "Rooms",
    responses: {
      200: "The Rooms readable by the bound ANVIL subject.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks rooms:read.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication, storage, or the ANVIL Room read seam is unavailable.",
    },
    invoke: (operations, authorization) => operations.listRooms(authorization),
  },
  {
    id: "getRoomSnapshot",
    method: "get",
    path: "/api/v1/rooms/{roomId}",
    scope: "rooms:read",
    routeSchema: RoomSnapshotInputSchema,
    paramsSchema: RoomIdParamsSchema,
    successSchema: RoomSnapshotSchema,
    successStatus: 200,
    resultMapping: "room-snapshot",
    summary: "Get a Room snapshot",
    description:
      "Returns the projected Room record (durable identity, status, committed room_seq high-water) and its active participants. Requires a durable room.read grant for the bound ANVIL subject on the target Room. Every response carries `observed_at` and `stale` freshness fields.",
    tag: "Rooms",
    responses: {
      200: "The Room snapshot.",
      400: "The roomId path parameter is invalid.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks rooms:read, or the bound ANVIL subject lacks room.read on the Room.",
      404: "The Room does not exist.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication, storage, or the ANVIL Room read seam is unavailable.",
    },
    invoke: (operations, authorization, input) =>
      operations.getRoomSnapshot(authorization, RoomSnapshotInputSchema.parse(input)),
  },
  {
    id: "replayRoomEvents",
    method: "get",
    path: "/api/v1/rooms/{roomId}/events",
    scope: "rooms:read",
    routeSchema: RoomEventsInputSchema,
    paramsSchema: RoomIdParamsSchema,
    querySchema: RoomEventsQuerySchema,
    successSchema: RoomEventPageSchema,
    successStatus: 200,
    resultMapping: "room-events",
    summary: "Replay Room events from a cursor",
    description:
      "Deterministic cursor replay over the canonical room_seq: committed events with room_seq greater than `after`, ascending, deduplicated on (room_id, room_seq). Reconnect by re-issuing your last seen room_seq as `after`; identical cursors replay identical pages. Requires a durable room.read grant for the bound ANVIL subject on the target Room. Every response carries `observed_at` and `stale`; observation-carrying kinds (sieve.projection) also report per-event `freshness`.",
    tag: "Rooms",
    responses: {
      200: "A page of committed Room events after the cursor.",
      400: "The roomId path parameter or replay cursor is invalid.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks rooms:read, or the bound ANVIL subject lacks room.read on the Room.",
      404: "The Room does not exist.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication, storage, or the ANVIL Room read seam is unavailable.",
    },
    invoke: (operations, authorization, input) =>
      operations.replayRoomEvents(authorization, RoomEventsInputSchema.parse(input)),
  },
  {
    id: "resumeExecution",
    method: "post",
    path: "/api/v1/controls/executions/{executionId}/resume",
    scope: "controls:operate",
    requestSchema: ControlIdempotencyBodySchema,
    routeSchema: ControlExecutionIdParamsSchema,
    paramsSchema: ControlExecutionIdParamsSchema,
    successSchema: ControlOperationResponseSchema,
    successStatus: 202,
    resultMapping: "control",
    summary: "Record an authorized resume intent for an execution",
    description:
      "Records the authorized durable resume intent for a terminal execution (applied by I3 convergence; Hub never rematerializes the execution). Requires a durable global control.resume grant for the Hub instance's bound ANVIL subject.",
    tag: "Controls",
    responses: {
      200: "The idempotency key replayed a previously recorded operation.",
      202: "The resume intent was durably recorded.",
      400: "The request body or executionId is invalid.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks controls:operate, or the bound ANVIL subject lacks a durable global control.resume grant.",
      404: "The execution does not exist in this organization.",
      409: "The execution is still live, or the idempotency key was already used for a different operation.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication, storage, or the ANVIL authority seam is unavailable.",
    },
    invoke: (operations, authorization, input) =>
      operations.resumeExecution(authorization, ExecutionControlInputSchema.parse(input)),
  },
  {
    id: "cancelExecution",
    method: "post",
    path: "/api/v1/controls/executions/{executionId}/cancel",
    scope: "controls:operate",
    requestSchema: ControlIdempotencyBodySchema,
    routeSchema: ControlExecutionIdParamsSchema,
    paramsSchema: ControlExecutionIdParamsSchema,
    successSchema: ControlOperationResponseSchema,
    successStatus: 200,
    resultMapping: "control",
    summary: "Cancel a live execution via a durable interrupt signal",
    description:
      "Sets the durable hub_action=interrupt signal on a live (spawning/running) execution; the daemon lifecycle picks the signal up across Hub restarts, and the terminal state is acknowledged back through the existing acknowledgement channel. Requires a durable global control.cancel grant for the Hub instance's bound ANVIL subject.",
    tag: "Controls",
    responses: {
      200: "The interrupt signal was durably applied, or the idempotency key replayed the stored operation.",
      400: "The request body or executionId is invalid.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks controls:operate, or the bound ANVIL subject lacks a durable global control.cancel grant.",
      404: "The execution does not exist in this organization.",
      409: "The execution is not live or already carries the interrupt signal, or the idempotency key was already used for a different operation.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication, storage, or the ANVIL authority seam is unavailable.",
    },
    invoke: (operations, authorization, input) =>
      operations.cancelExecution(authorization, ExecutionControlInputSchema.parse(input)),
  },
  {
    id: "retryExecution",
    method: "post",
    path: "/api/v1/controls/executions/{executionId}/retry",
    scope: "controls:operate",
    requestSchema: ControlIdempotencyBodySchema,
    routeSchema: ControlExecutionIdParamsSchema,
    paramsSchema: ControlExecutionIdParamsSchema,
    successSchema: ControlOperationResponseSchema,
    successStatus: 202,
    resultMapping: "control",
    summary: "Record an authorized retry intent for an execution",
    description:
      "Records the authorized durable retry intent for a non-live execution (materialized by I3 convergence; Hub never rematerializes the execution). Requires a durable global control.retry grant for the Hub instance's bound ANVIL subject.",
    tag: "Controls",
    responses: {
      200: "The idempotency key replayed a previously recorded operation.",
      202: "The retry intent was durably recorded.",
      400: "The request body or executionId is invalid.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks controls:operate, or the bound ANVIL subject lacks a durable global control.retry grant.",
      404: "The execution does not exist in this organization.",
      409: "The execution is still live, or the idempotency key was already used for a different operation.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication, storage, or the ANVIL authority seam is unavailable.",
    },
    invoke: (operations, authorization, input) =>
      operations.retryExecution(authorization, ExecutionControlInputSchema.parse(input)),
  },
  {
    id: "acknowledgeAttention",
    method: "post",
    path: "/api/v1/controls/executions/{executionId}/acknowledge",
    scope: "controls:operate",
    requestSchema: AcknowledgeAttentionRequestSchema,
    routeSchema: ControlExecutionIdParamsSchema,
    paramsSchema: ControlExecutionIdParamsSchema,
    successSchema: ControlOperationResponseSchema,
    successStatus: 200,
    resultMapping: "control",
    summary: "Acknowledge a client-side execution attention state",
    description:
      "Records a client-side attention acknowledgement (terminal/idle) against a live execution through the existing hub_action_acknowledgements state. The finish_execution_call kind is daemon-side only and is rejected here. Requires a durable global control.acknowledge grant for the Hub instance's bound ANVIL subject.",
    tag: "Controls",
    responses: {
      200: "The acknowledgement was durably applied, or the idempotency key replayed the stored operation.",
      400: "The request body or executionId is invalid.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks controls:operate, or the bound ANVIL subject lacks a durable global control.acknowledge grant.",
      404: "The execution does not exist in this organization.",
      409: "The attention kind is daemon-side only, or the idempotency key was already used for a different operation.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication, storage, or the ANVIL authority seam is unavailable.",
    },
    invoke: (operations, authorization, input) =>
      operations.acknowledgeAttention(authorization, AcknowledgeAttentionInputSchema.parse(input)),
  },
  {
    id: "startApprovedExecution",
    method: "post",
    path: "/api/v1/controls/executions/start",
    scope: "controls:operate",
    requestSchema: StartApprovedExecutionRequestSchema,
    successSchema: ControlOperationResponseSchema,
    successStatus: 201,
    resultMapping: "control",
    summary: "Start an approved execution through manual-run dispatch",
    description:
      "Dispatches a manual run for the named trigger and project — the same governed manual.run path as the Runs surface, with the approved execution's idempotency key flowing through as the delivery key. Requires a durable global control.execution_start grant for the Hub instance's bound ANVIL subject.",
    tag: "Controls",
    responses: {
      200: "The idempotency key replayed a previously recorded operation.",
      201: "The approved execution was dispatched.",
      400: "The request body is invalid.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks controls:operate, or the bound ANVIL subject lacks a durable global control.execution_start grant.",
      404: "The project or trigger does not exist in this organization.",
      409: "Dispatch could not complete (daemon offline, dispatch conflict), or the idempotency key was already used for a different operation.",
      422: "The trigger input was rejected.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication, storage, or the ANVIL authority seam is unavailable.",
    },
    invoke: (operations, authorization, input) =>
      operations.startApprovedExecution(
        authorization,
        StartApprovedExecutionRequestSchema.parse(input),
      ),
  },
  {
    id: "getControlOperation",
    method: "get",
    path: "/api/v1/controls/operations/{operationId}",
    scope: "controls:read",
    routeSchema: GetControlOperationInputSchema,
    paramsSchema: ControlOperationIdParamsSchema,
    successSchema: ControlOperationResponseSchema,
    successStatus: 200,
    resultMapping: "control",
    summary: "Get a recorded control operation",
    description:
      "Reads one recorded I4 control operation from the Hub-local ledger by its durable id.",
    tag: "Controls",
    responses: {
      200: "The recorded control operation.",
      400: "The operationId path parameter is invalid.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks controls:read.",
      404: "No control operation with that id exists in this organization.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication, storage, or the ANVIL authority seam is unavailable.",
    },
    invoke: (operations, authorization, input) =>
      operations.getControlOperation(authorization, GetControlOperationInputSchema.parse(input)),
  },
  {
    id: "listControlOperations",
    method: "get",
    path: "/api/v1/controls/operations",
    scope: "controls:read",
    routeSchema: ListControlOperationsInputSchema,
    querySchema: ControlOperationsQuerySchema,
    successSchema: ControlOperationListSchema,
    successStatus: 200,
    resultMapping: "control-list",
    summary: "List recorded control operations",
    description:
      "Lists recorded I4 control operations from the Hub-local ledger, newest first, with optional execution/op/status filters.",
    tag: "Controls",
    responses: {
      200: "The recorded control operations.",
      400: "A query parameter is invalid.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks controls:read.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication, storage, or the ANVIL authority seam is unavailable.",
    },
    invoke: (operations, authorization, input) =>
      operations.listControlOperations(
        authorization,
        ListControlOperationsInputSchema.parse(input),
      ),
  },
  {
    id: "getExecution",
    method: "get",
    path: "/api/v1/executions/{executionId}",
    scope: "rooms:read",
    routeSchema: ExecutionRouteSchema,
    paramsSchema: ExecutionIdParamsSchema,
    successSchema: ExecutionDescriptionSchema,
    successStatus: 200,
    resultMapping: "execution",
    summary: "Observe one ANVIL-bound execution",
    description:
      "Returns the durable ANVIL execution lifecycle state (state, substate, last committed transition) for an execution bound to a Room. Requires rooms:read plus a durable room.read grant for the bound ANVIL subject on the execution's Room — the same capability-checked read seam as the Room endpoints.",
    tag: "Executions",
    responses: {
      200: "The execution's durable authority state.",
      400: "The executionId path parameter is invalid.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks rooms:read, or the bound ANVIL subject lacks room.read on the execution's Room.",
      404: "No ANVIL-bound execution exists with that id.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication, storage, or the ANVIL authority seam is unavailable.",
    },
    invoke: (operations, authorization, input) =>
      operations.getExecution(authorization, ExecutionRouteSchema.parse(input)),
  },
  {
    id: "mintExecutionGrant",
    method: "post",
    path: "/api/v1/executions/{executionId}/grants",
    scope: "executions:control",
    requestSchema: MintExecutionGrantRequestSchema,
    routeSchema: ExecutionRouteSchema,
    paramsSchema: ExecutionIdParamsSchema,
    successSchema: MintedExecutionGrantSchema,
    successStatus: 201,
    resultMapping: "execution-grant",
    summary: "Mint a single-action execution capability grant",
    description:
      "Mints a Hub-issued capability grant in anvil.capability_grants scoped to (execution_id, action, your credential-derived principal). Present the returned grant_id on the action endpoint. Grants are short-lived, single-action, and bound to the requesting principal — they are never forwardable. Minting is rejected for actions that can never apply to the execution's current authority state.",
    tag: "Executions",
    responses: {
      201: "The minted capability grant.",
      400: "The request body or executionId path parameter is invalid.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks executions:control, or the bound ANVIL subject lacks room.execute on the execution's Room.",
      404: "The execution does not exist.",
      409: "The execution has no authority binding, the action is not legal from its current state, or its Room is not active.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication, storage, or the ANVIL authority write seam is unavailable.",
    },
    invoke: (operations, authorization, input) => {
      const parsed = MintExecutionGrantInputSchema.parse(input);
      return operations.mintExecutionGrant(authorization, {
        executionId: parsed.executionId,
        action: parsed.action,
        ttlSeconds: parsed.ttl_seconds,
      });
    },
  },
  {
    id: "controlExecution",
    method: "post",
    path: "/api/v1/executions/{executionId}/actions/{action}",
    scope: "executions:control",
    requestSchema: ControlExecutionRequestSchema,
    routeSchema: ExecutionActionRouteSchema,
    paramsSchema: ExecutionActionParamsSchema,
    successSchema: ExecutionActionOutcomeSchema,
    successStatus: 200,
    resultMapping: "execution-action",
    summary: "Act on an execution under a capability grant",
    description:
      "Performs one grant-scoped control action (start, pause, resume, cancel, retry, acknowledge). Validates grant → execution → principal → expiry, fails closed: a missing, expired, revoked, or mismatched grant answers capability_denied — never insufficient_scope. The committed authority transition (kind execution.transition, causation hub:control:<grant_id>) is returned as room_seq/event_id; duplicate:true means the same (execution, action, grant) was already committed and the ids name the original commit.",
    tag: "Executions",
    responses: {
      200: "The action's committed authority transition.",
      400: "The request body or path parameters are invalid.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks executions:control, or the grant failed validation (missing, expired, revoked, wrong action/correlation/principal, wrong room scope).",
      404: "The execution does not exist.",
      409: "The execution has no authority binding, the action is not legal from its current state, or its Room is not active.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication, storage, or the ANVIL authority write seam is unavailable.",
    },
    invoke: (operations, authorization, input) => {
      const parsed = ControlExecutionInputSchema.parse(input);
      return operations.controlExecution(authorization, {
        executionId: parsed.executionId,
        action: parsed.action,
        grantId: parsed.grant_id,
        ...(parsed.request_id === undefined ? {} : { requestId: parsed.request_id }),
      });
    },
  },
];

export function publicOperation(id: PublicOperationId): PublicOperationDefinition {
  const definition = publicOperationManifest.find((candidate) => candidate.id === id);
  if (definition === undefined) throw new Error(`unknown public operation: ${id}`);
  return definition;
}
