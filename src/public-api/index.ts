import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { OperationAuthenticator } from "../auth/operation-auth.js";
import { isDatabaseUnavailableError } from "../db/errors.js";
import { reportFailure } from "../failures/index.js";
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
  ListProjectsResult,
  ListRoomsResult,
  ListTriggersResult,
  ListConfigurationResourcesResult,
  ListSetupResourcesResult,
  MintExecutionGrantResult,
  PublicAuthorization,
  PublicOperations,
  ReplayRoomEventsResult,
  StartApprovedExecutionResult,
  ValidateConfigurationResult,
  ValidateTriggerResult,
} from "../public-operations/index.js";
import {
  ControlOperationListSchema,
  ControlOperationResponseSchema,
  DispatchedManualRunSchema,
  EnrollmentTokenSchema,
  ExecutionActionOutcomeSchema,
  ExecutionDescriptionSchema,
  InstalledConfigurationSchema,
  InstalledTriggerSchema,
  MintedExecutionGrantSchema,
  ProjectListSchema,
  RoomEventPageSchema,
  RoomListSchema,
  RoomSnapshotSchema,
  TriggerListSchema,
  ConfigurationResourcesSchema,
  SetupResourcesSchema,
  ProblemSchema,
  ValidatedConfigurationSchema,
  ValidatedTriggerSchema,
  type Problem,
} from "./contracts.js";
import { publicOpenApiDocument } from "./openapi.js";
import {
  publicOperation,
  publicOperationManifest,
  type PublicOperationId,
  type PublicOperationDefinition,
} from "./operation-manifest.js";

export type { PublicOperationId } from "./operation-manifest.js";

type PublicOperationResult =
  | ValidateTriggerResult
  | InstallTriggerResult
  | ListTriggersResult
  | ListProjectsResult
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
  | ControlExecutionOperationResult;

export interface PublicApi {
  handle(request: Request): Promise<Response>;
  handleOperation(id: PublicOperationId, request: Request): Promise<Response>;
  openapi(): Response;
}

export type PublicApiComposition =
  | { status: "enabled"; authenticator: OperationAuthenticator }
  | { status: "unavailable" };

export function createPublicApi(
  composition: PublicApiComposition,
  operations: PublicOperations | null,
): PublicApi {
  if (composition.status === "enabled" && operations === null) {
    throw new Error("enabled public API requires application operations");
  }
  return {
    handle(request) {
      const url = new URL(request.url);
      const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
      const pathMatches = publicOperationManifest.flatMap((route) => {
        const params = matchRoutePath(route.path, url.pathname);
        return params === undefined ? [] : [{ route, params }];
      });
      if (pathMatches.length === 0) {
        return Promise.resolve(
          problem(
            requestId,
            404,
            "not_found",
            "Not found",
            "No canonical API route matches this path.",
          ),
        );
      }
      const matched = pathMatches.find(
        ({ route }) => route.method.toUpperCase() === request.method.toUpperCase(),
      );
      if (matched === undefined) {
        const response = problem(
          requestId,
          405,
          "method_not_allowed",
          "Method not allowed",
          "Use one of the methods listed in the Allow response header.",
        );
        response.headers.set(
          "allow",
          pathMatches.map(({ route }) => route.method.toUpperCase()).join(", "),
        );
        return Promise.resolve(response);
      }
      return executeSafely(
        matched.route.id,
        request,
        requestId,
        composition,
        operations,
        matched.params,
      );
    },
    handleOperation(id, request) {
      const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
      const params = matchRoutePath(publicOperation(id).path, new URL(request.url).pathname) ?? {};
      return executeSafely(id, request, requestId, composition, operations, params);
    },
    openapi() {
      return Response.json(publicOpenApiDocument, {
        headers: { "cache-control": "public, max-age=300" },
      });
    },
  };
}

/**
 * Matches a manifest path template against a request pathname. `{name}`
 * segments capture one non-empty path segment each; exact templates match
 * literally and capture nothing.
 */
function matchRoutePath(template: string, pathname: string): Record<string, string> | undefined {
  if (!template.includes("{")) return template === pathname ? {} : undefined;
  const names: string[] = [];
  const source = template
    .split("/")
    .map((segment) => {
      if (segment.startsWith("{") && segment.endsWith("}") && segment.length > 2) {
        names.push(segment.slice(1, -1));
        return "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  const match = new RegExp(`^${source}$`, "u").exec(pathname);
  if (match === null) return undefined;
  return Object.fromEntries(
    names.map((name, index) => [name, decodeURIComponent(match[index + 1]!)]),
  );
}

async function executeSafely(
  id: PublicOperationId,
  request: Request,
  requestId: string,
  composition: PublicApiComposition,
  operations: PublicOperations | null,
  routeParams: Record<string, string>,
): Promise<Response> {
  try {
    if (composition.status === "unavailable" || operations === null) {
      return problem(
        requestId,
        503,
        "infrastructure_unavailable",
        "Service unavailable",
        "Public API authentication or storage is currently unavailable.",
      );
    }
    return await execute(
      id,
      request,
      requestId,
      composition.authenticator,
      operations,
      routeParams,
    );
  } catch (error) {
    reportFailure(
      error,
      {
        operation: `public-api.${id}`,
        component: "public-api",
        requestId,
        status: isDatabaseUnavailableError(error) ? 503 : 500,
      },
      { status: isDatabaseUnavailableError(error) ? 503 : 500 },
    );
    if (isDatabaseUnavailableError(error)) return infrastructureProblem(requestId);
    return problem(
      requestId,
      500,
      "internal_error",
      "Internal server error",
      "The operation failed unexpectedly. Contact the Hub operator with the request ID.",
    );
  }
}

async function execute(
  id: PublicOperationId,
  request: Request,
  requestId: string,
  authenticator: OperationAuthenticator,
  operations: PublicOperations,
  routeParams: Record<string, string>,
): Promise<Response> {
  const definition = publicOperation(id);
  const scope = definition.scope;
  let authorization;
  try {
    authorization = await authenticator.authorize(request, scope);
  } catch (error) {
    if (!isDatabaseUnavailableError(error)) throw error;
    return problem(
      requestId,
      503,
      "authentication_unavailable",
      "Authentication unavailable",
      "Bearer-credential authentication is currently unavailable. Retry the request later.",
    );
  }
  if (authorization.status === "unauthorized") {
    return problem(
      requestId,
      401,
      "unauthorized",
      "Authentication required",
      "Provide an active Paseo organization credential in the Authorization: Bearer header.",
    );
  }
  if (authorization.status === "forbidden") {
    return problem(
      requestId,
      403,
      "insufficient_scope",
      "Insufficient scope",
      `This operation requires the ${scope} scope.`,
    );
  }
  const access: PublicAuthorization = authorization.access;
  let input: unknown;
  let bodyInput: Record<string, unknown> | undefined;
  if (definition.requestSchema !== undefined) {
    const parsedBody = await readJson(request);
    if (!parsedBody.success) {
      return problem(
        requestId,
        400,
        "invalid_json",
        "Invalid JSON",
        "Send a JSON request body using Content-Type: application/json.",
      );
    }
    const parsed = definition.requestSchema.safeParse(parsedBody.value);
    if (!parsed.success) {
      return validationProblem(requestId, parsed.error.issues);
    }
    input = parsed.data;
    if (typeof parsed.data === "object" && parsed.data !== null) {
      const record = z.record(z.string(), z.unknown()).safeParse(parsed.data);
      if (record.success) {
        bodyInput = record.data;
      }
    }
  }
  if (definition.routeSchema !== undefined) {
    const url = new URL(request.url);
    const routeInput: Record<string, unknown> = {};
    for (const [key, value] of url.searchParams) {
      routeInput[key] = value;
    }
    Object.assign(routeInput, routeParams);
    const parsed = definition.routeSchema.safeParse(routeInput);
    if (!parsed.success) {
      return validationProblem(requestId, parsed.error.issues);
    }
    // When a mutating op carries both a JSON body and path parameters, the
    // invoke callback receives the merged object (body fields win on
    // collision; existing op surfaces never set both schemas).
    let merged: unknown = parsed.data;
    const routeRecord = z.record(z.string(), z.unknown()).safeParse(parsed.data);
    if (bodyInput !== undefined && routeRecord.success) {
      merged = { ...routeRecord.data, ...bodyInput };
    }
    input = merged;
  }
  const result = await definition.invoke(operations, access, input);
  if (definition.resultMapping === "triggers") {
    if (!isTriggersResult(result)) throw new Error("invalid triggers operation result");
    return triggersResponse(requestId, result);
  }
  return operationResponse(definition.resultMapping, requestId, result);
}

type ResultMapping = Exclude<PublicOperationDefinition["resultMapping"], "triggers">;

const RESULT_RESPONDERS: Record<
  ResultMapping,
  (requestId: string, result: PublicOperationResult) => Response
> = {
  "trigger-validation": (requestId, result) =>
    triggerValidationResponse(
      requestId,
      requireResult(isTriggerValidationResult, result, "trigger validation"),
    ),
  "trigger-installation": (requestId, result) =>
    triggerInstallationResponse(
      requestId,
      requireResult(isTriggerInstallationResult, result, "trigger installation"),
    ),
  projects: (requestId, result) =>
    projectsResponse(requestId, requireResult(isProjectsResult, result, "projects")),
  "configuration-resources": (requestId, result) =>
    configurationResourcesResponse(
      requestId,
      requireResult(isConfigurationResourcesResult, result, "configuration resources"),
    ),
  "setup-resources": (requestId, result) =>
    setupResourcesResponse(
      requestId,
      requireResult(isSetupResourcesResult, result, "setup resources"),
    ),
  validation: (requestId, result) =>
    validationResponse(requestId, requireResult(isValidationResult, result, "validation")),
  configuration: (requestId, result) =>
    installationResponse(requestId, requireResult(isInstallationResult, result, "configuration")),
  "manual-run": (requestId, result) =>
    manualRunResponse(requestId, requireResult(isManualRunResult, result, "manual-run")),
  "enrollment-token": (requestId, result) =>
    enrollmentResponse(requestId, requireResult(isEnrollmentResult, result, "enrollment")),
  rooms: (requestId, result) =>
    roomsResponse(requestId, requireResult(isRoomsResult, result, "rooms")),
  "room-snapshot": (requestId, result) =>
    roomSnapshotResponse(requestId, requireResult(isRoomSnapshotResult, result, "room snapshot")),
  "room-events": (requestId, result) =>
    roomEventsResponse(requestId, requireResult(isRoomEventsResult, result, "room events")),
  control: (requestId, result) =>
    controlResponse(requestId, requireResult(isControlResult, result, "control")),
  "control-list": (requestId, result) =>
    controlListResponse(requestId, requireResult(isControlListResult, result, "control list")),
  execution: (requestId, result) =>
    executionResponse(requestId, requireResult(isExecutionResult, result, "execution")),
  "execution-grant": (requestId, result) =>
    executionGrantResponse(
      requestId,
      requireResult(isExecutionGrantResult, result, "execution grant"),
    ),
  "execution-action": (requestId, result) =>
    executionActionResponse(
      requestId,
      requireResult(isExecutionActionResult, result, "execution action"),
    ),
};

function requireResult<Narrowed extends PublicOperationResult>(
  guard: (result: PublicOperationResult) => result is Narrowed,
  result: PublicOperationResult,
  operation: string,
): Narrowed {
  if (!guard(result)) throw new Error(`invalid ${operation} operation result`);
  return result;
}

function operationResponse(
  mapping: ResultMapping,
  requestId: string,
  result: PublicOperationResult,
): Response {
  return RESULT_RESPONDERS[mapping](requestId, result);
}

function roomsResponse(requestId: string, result: ListRoomsResult): Response {
  switch (result.status) {
    case "listed":
      return success(requestId, 200, RoomListSchema, {
        rooms: result.rooms,
        observed_at: result.observed_at,
        stale: result.stale,
      });
    case "room_projection_unavailable":
      return roomProjectionUnavailableProblem(requestId);
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

function roomSnapshotResponse(requestId: string, result: GetRoomSnapshotResult): Response {
  switch (result.status) {
    case "ok":
      return success(requestId, 200, RoomSnapshotSchema, {
        room: result.room,
        participants: result.participants,
        observed_at: result.observed_at,
        stale: result.stale,
      });
    case "room_not_found":
      return problem(
        requestId,
        404,
        "room_not_found",
        "Room not found",
        "No ANVIL Room exists with that public_id.",
      );
    case "capability_denied":
      return capabilityDeniedProblem(requestId);
    case "room_projection_unavailable":
      return roomProjectionUnavailableProblem(requestId);
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

function roomEventsResponse(requestId: string, result: ReplayRoomEventsResult): Response {
  switch (result.status) {
    case "ok":
      return success(requestId, 200, RoomEventPageSchema, {
        room: result.room,
        events: result.events,
        latest_seq: result.latest_seq,
        next_cursor: result.next_cursor,
        has_more: result.has_more,
        observed_at: result.observed_at,
        stale: result.stale,
      });
    case "room_not_found":
      return problem(
        requestId,
        404,
        "room_not_found",
        "Room not found",
        "No ANVIL Room exists with that public_id.",
      );
    case "capability_denied":
      return capabilityDeniedProblem(requestId);
    case "room_projection_unavailable":
      return roomProjectionUnavailableProblem(requestId);
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

function executionResponse(requestId: string, result: GetExecutionResult): Response {
  switch (result.status) {
    case "ok":
      return success(requestId, 200, ExecutionDescriptionSchema, {
        execution_id: result.execution_id,
        room_id: result.room_id,
        correlation_id: result.correlation_id,
        state: result.state,
        substate: result.substate,
        last_transition: result.last_transition,
        correlation: result.correlation,
      });
    case "execution_not_found":
      return problem(
        requestId,
        404,
        "execution_not_found",
        "Execution not found",
        "No ANVIL-bound execution exists with that id.",
      );
    case "room_not_found":
      return problem(
        requestId,
        404,
        "room_not_found",
        "Room not found",
        "No ANVIL Room exists with the execution's room public_id.",
      );
    case "capability_denied":
      return capabilityDeniedProblem(requestId);
    case "execution_control_unavailable":
      return executionControlUnavailableProblem(requestId);
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

function executionGrantResponse(requestId: string, result: MintExecutionGrantResult): Response {
  switch (result.status) {
    case "minted":
      return success(requestId, 201, MintedExecutionGrantSchema, {
        grant_id: result.grant_id,
        execution_id: result.execution_id,
        action: result.action,
        principal: result.principal,
        issued_at: result.issued_at,
        expires_at: result.expires_at,
        scope_hash: result.scope_hash,
      });
    case "execution_not_found":
      return problem(
        requestId,
        404,
        "execution_not_found",
        "Execution not found",
        "No execution with that id exists in the credential's organization.",
      );
    case "execution_not_bound":
      return executionNotBoundProblem(requestId);
    case "capability_denied":
      return capabilityDeniedProblem(requestId);
    case "invalid_state":
      return invalidStateProblem(requestId);
    case "room_not_active":
      return roomNotActiveProblem(requestId);
    case "execution_control_unavailable":
      return executionControlUnavailableProblem(requestId);
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

function executionActionResponse(
  requestId: string,
  result: ControlExecutionOperationResult,
): Response {
  switch (result.status) {
    case "applied":
      return success(requestId, 200, ExecutionActionOutcomeSchema, {
        execution_id: result.execution_id,
        state: result.state,
        substate: result.substate,
        room_seq: result.room_seq,
        event_id: result.event_id,
        duplicate: result.duplicate,
        effect_applied: result.effect_applied,
        ...(result.retry_execution_id === undefined
          ? {}
          : { retry_execution_id: result.retry_execution_id }),
      });
    case "execution_not_found":
      return problem(
        requestId,
        404,
        "execution_not_found",
        "Execution not found",
        "No execution with that id exists in the credential's organization.",
      );
    case "execution_not_bound":
      return executionNotBoundProblem(requestId);
    case "capability_denied":
      return capabilityDeniedProblem(requestId);
    case "invalid_state":
      return invalidStateProblem(requestId);
    case "room_not_active":
      return roomNotActiveProblem(requestId);
    case "execution_control_unavailable":
      return executionControlUnavailableProblem(requestId);
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

function executionNotBoundProblem(requestId: string): Response {
  return problem(
    requestId,
    409,
    "execution_not_bound",
    "Execution not bound",
    "The execution has no active ANVIL execution binding; control requires the identity spine.",
  );
}

function invalidStateProblem(requestId: string): Response {
  return problem(
    requestId,
    409,
    "invalid_state",
    "Invalid execution state",
    "The requested action is not legal from the execution's current authority state.",
  );
}

function roomNotActiveProblem(requestId: string): Response {
  return problem(
    requestId,
    409,
    "room_not_active",
    "Room not active",
    "The execution's owning Room is not active; authority rejects further appends.",
  );
}

function executionControlUnavailableProblem(requestId: string): Response {
  return problem(
    requestId,
    503,
    "execution_control_unavailable",
    "Execution control unavailable",
    "This Hub instance is not configured with the ANVIL authority write seam.",
  );
}

function capabilityDeniedProblem(requestId: string): Response {
  return problem(
    requestId,
    403,
    "capability_denied",
    "Capability denied",
    "The presented grant is missing, expired, revoked, or does not cover this execution, action, and principal — or the bound ANVIL subject lacks the required authority capability.",
  );
}

/** I4 Hub Control Contract V1 — one control op response (mutating ops and get). */
function controlResponse(
  requestId: string,
  result: ControlExecutionResult | StartApprovedExecutionResult | GetControlOperationResult,
): Response {
  switch (result.status) {
    case "applied":
      // Contract V1: execution_start creates a dispatch (201); every other
      // applied op is an effect on an existing resource (200).
      return success(
        requestId,
        result.operation.op === "execution_start" ? 201 : 200,
        ControlOperationResponseSchema,
        { operation: result.operation },
      );
    case "recorded":
      return success(requestId, 202, ControlOperationResponseSchema, {
        operation: result.operation,
      });
    case "replayed":
      return success(requestId, 200, ControlOperationResponseSchema, {
        operation: result.operation,
      });
    case "ok":
      return success(requestId, 200, ControlOperationResponseSchema, {
        operation: result.operation,
      });
    case "invalid_input":
      return validationProblem(requestId, result.issues);
    case "execution_not_found":
      return problem(
        requestId,
        404,
        "execution_not_found",
        "Execution not found",
        "No agent execution with that id exists in this organization.",
      );
    case "control_capability_denied":
      return problem(
        requestId,
        403,
        "control_capability_denied",
        "Control capability denied",
        `The Hub instance's bound ANVIL subject lacks a durable global ${result.capability} grant.`,
      );
    case "control_precondition_failed":
      return problem(
        requestId,
        409,
        "control_precondition_failed",
        "Control precondition failed",
        `The control operation could not be recorded or applied: ${result.reason}.`,
      );
    case "idempotency_key_conflict":
      return problem(
        requestId,
        409,
        "idempotency_key_conflict",
        "Idempotency key conflict",
        `This idempotency key was already used for a different control operation (${result.existingOperationId}). Use a fresh key.`,
      );
    case "control_plane_unavailable":
      return problem(
        requestId,
        503,
        "control_plane_unavailable",
        "Control plane unavailable",
        "This Hub instance is not configured with the ANVIL authority seam that authorizes control operations.",
      );
    case "control_operation_not_found":
      return problem(
        requestId,
        404,
        "control_operation_not_found",
        "Control operation not found",
        "No recorded control operation with that id exists in this organization.",
      );
    case "project_not_found":
      return problem(
        requestId,
        404,
        "project_not_found",
        "Project not found",
        "No active project with that slug exists in this organization.",
      );
    case "trigger_not_found":
      return problem(
        requestId,
        404,
        "trigger_not_found",
        "Trigger not found",
        "No enabled manual trigger with that name exists for the project.",
      );
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

function controlListResponse(requestId: string, result: ListControlOperationsResult): Response {
  switch (result.status) {
    case "listed":
      return success(requestId, 200, ControlOperationListSchema, {
        operations: result.operations,
      });
    case "control_plane_unavailable":
      return problem(
        requestId,
        503,
        "control_plane_unavailable",
        "Control plane unavailable",
        "This Hub instance is not configured with the ANVIL authority seam that authorizes control operations.",
      );
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

function roomProjectionUnavailableProblem(requestId: string): Response {
  return problem(
    requestId,
    503,
    "room_projection_unavailable",
    "Room projection unavailable",
    "This Hub instance is not configured with an ANVIL Room read seam.",
  );
}

function triggersResponse(requestId: string, result: ListTriggersResult): Response {
  return result.status === "listed"
    ? success(requestId, 200, TriggerListSchema, { triggers: result.triggers })
    : infrastructureProblem(requestId);
}

function triggerValidationResponse(requestId: string, result: ValidateTriggerResult): Response {
  switch (result.status) {
    case "valid":
      return success(requestId, 200, ValidatedTriggerSchema, { name: result.name, valid: true });
    case "invalid_trigger":
      return problem(
        requestId,
        422,
        "invalid_trigger",
        "Invalid trigger",
        "Correct the self-contained trigger YAML.",
        result.issues,
      );
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

function triggerInstallationResponse(requestId: string, result: InstallTriggerResult): Response {
  switch (result.status) {
    case "installed":
      return success(requestId, 201, InstalledTriggerSchema, {
        triggerId: result.triggerId,
        name: result.name,
        revisionId: result.revisionId,
        version: result.version,
        active: true,
      });
    case "invalid_trigger":
      return problem(
        requestId,
        422,
        "invalid_trigger",
        "Invalid trigger",
        "Correct the self-contained trigger YAML and submit it again.",
        result.issues,
      );
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

function projectsResponse(requestId: string, result: ListProjectsResult): Response {
  return result.status === "listed"
    ? success(requestId, 200, ProjectListSchema, { projects: result.projects })
    : infrastructureProblem(requestId);
}

function configurationResourcesResponse(
  requestId: string,
  result: ListConfigurationResourcesResult,
): Response {
  return result.status === "listed"
    ? success(requestId, 200, ConfigurationResourcesSchema, {
        daemons: result.daemons,
        github: result.github,
        discord: result.discord,
        slack: result.slack,
        linear: result.linear,
      })
    : infrastructureProblem(requestId);
}

function setupResourcesResponse(requestId: string, result: ListSetupResourcesResult): Response {
  return result.status === "listed"
    ? success(requestId, 200, SetupResourcesSchema, {
        github: result.github,
        discord: result.discord,
        slack: result.slack,
      })
    : infrastructureProblem(requestId);
}

function validationResponse(requestId: string, result: ValidateConfigurationResult): Response {
  switch (result.status) {
    case "valid":
      return success(requestId, 200, ValidatedConfigurationSchema, {
        projectSlug: result.projectSlug,
        valid: true,
        ...(result.wouldCreateProject === true ? { wouldCreateProject: true } : {}),
      });
    case "project_not_found":
      return problem(
        requestId,
        404,
        "project_not_found",
        "Project not found",
        "No active project with that slug exists in the credential's organization.",
      );
    case "invalid_bundle":
      return problem(
        requestId,
        422,
        "invalid_configuration_bundle",
        "Invalid configuration bundle",
        "Correct the canonical Hub bundle files.",
        result.issues,
      );
    case "invalid_configuration":
      return problem(
        requestId,
        422,
        "invalid_configuration",
        "Invalid configuration",
        "See issues for configuration errors.",
        result.issues,
      );
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

async function readJson(
  request: Request,
): Promise<{ success: true; value: unknown } | { success: false }> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return { success: false };
  }
  try {
    return { success: true, value: await request.json() };
  } catch {
    return { success: false };
  }
}

function validationProblem(
  requestId: string,
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): Response {
  return problem(
    requestId,
    400,
    "invalid_request",
    "Invalid request",
    "The request body contains invalid fields.",
    issues.map((issue) => ({
      path: issue.path.flatMap((part) => (typeof part === "symbol" ? [] : [part])),
      message: issue.message,
    })),
  );
}

function installationResponse(requestId: string, result: InstallConfigurationResult): Response {
  switch (result.status) {
    case "installed":
      return success(requestId, 201, InstalledConfigurationSchema, {
        projectSlug: result.projectSlug,
        versionId: result.versionId,
        version: result.version,
        active: result.active,
      });
    case "project_not_found":
      return problem(
        requestId,
        404,
        "project_not_found",
        "Project not found",
        "No active project with that slug exists in the credential's organization.",
      );
    case "invalid_bundle":
      return problem(
        requestId,
        422,
        "invalid_configuration_bundle",
        "Invalid configuration bundle",
        "Correct the canonical Hub bundle files and submit them again.",
        result.issues,
      );
    case "invalid_configuration":
      return problem(
        requestId,
        422,
        "invalid_configuration",
        "Invalid configuration",
        `Configuration revision ${result.versionId} was recorded but not activated.`,
        result.issues,
      );
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

function manualRunResponse(requestId: string, result: DispatchManualRunResult): Response {
  switch (result.status) {
    case "dispatched":
      return success(requestId, 200, DispatchedManualRunSchema, {
        deliveryKey: result.deliveryKey,
        providerEventReceiptId: result.providerEventReceiptId,
        triggerRunId: result.triggerRunId,
        configuredTriggerName: result.configuredTriggerName,
        workflowStatus: result.workflowStatus,
      });
    case "project_not_found":
      return problem(
        requestId,
        404,
        "project_not_found",
        "Project not found",
        "No active project with that slug exists in the credential's organization.",
      );
    case "actor_forbidden":
      return problem(
        requestId,
        403,
        "actor_forbidden",
        "Actor forbidden",
        "The configured manual trigger does not allow this actor.",
      );
    case "configuration_not_found":
      return problem(
        requestId,
        404,
        "configuration_not_found",
        "Configuration not found",
        "The requested configuration revision is not available.",
      );
    case "trigger_not_found":
      return problem(
        requestId,
        404,
        "trigger_not_found",
        "Trigger not found",
        "The active configuration has no matching manual trigger.",
      );
    case "expected_configuration_not_current":
      return problem(
        requestId,
        409,
        "configuration_changed",
        "Configuration changed",
        "expectedVersionId is not the configuration version selected for this delivery.",
      );
    case "daemon_offline":
      return problem(
        requestId,
        409,
        "daemon_offline",
        "Daemon offline",
        "The selected daemon is not connected. Reconnect it before retrying.",
      );
    case "invalid_input":
      return problem(
        requestId,
        400,
        "invalid_input",
        "Invalid trigger input",
        `Run ${result.triggerRunId} rejected the submitted input.`,
        result.issues,
      );
    case "dispatch_conflict":
      return problem(
        requestId,
        409,
        "dispatch_conflict",
        "Run not dispatched",
        "The durable event exists but no matching run is available yet. Retry with the same deliveryKey.",
      );
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

function enrollmentResponse(requestId: string, result: IssueEnrollmentTokenResult): Response {
  switch (result.status) {
    case "issued":
      return success(requestId, 201, EnrollmentTokenSchema, {
        token: result.token,
        expiresAt: result.expiresAt.toISOString(),
      });
    case "credential_revoked":
      return problem(
        requestId,
        401,
        "unauthorized",
        "Authentication required",
        "The organization credential was revoked before the enrollment token could be issued.",
      );
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

function infrastructureProblem(requestId: string): Response {
  return problem(
    requestId,
    503,
    "infrastructure_unavailable",
    "Service unavailable",
    "The operation could not reach durable storage. Retry the request later.",
  );
}

function success(
  requestId: string,
  status: number,
  schema: { parse(value: unknown): unknown },
  value: unknown,
): Response {
  return Response.json(schema.parse(value), { status, headers: { "x-request-id": requestId } });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled public operation result: ${String(value)}`);
}

function problem(
  requestId: string,
  status: number,
  code: string,
  title: string,
  detail: string,
  issues?: readonly { path: readonly (string | number)[]; message: string }[],
): Response {
  const body: Problem = ProblemSchema.parse({
    type: `https://paseo.sh/problems/${code.replaceAll("_", "-")}`,
    title,
    status,
    detail,
    code,
    requestId,
    ...(issues === undefined ? {} : { issues }),
  });
  return Response.json(body, {
    status,
    headers: {
      "content-type": "application/problem+json",
      "x-request-id": requestId,
      ...(status === 401 ? { "www-authenticate": "Bearer" } : {}),
    },
  });
}

function isInstallationResult(result: PublicOperationResult): result is InstallConfigurationResult {
  return [
    "installed",
    "project_not_found",
    "invalid_bundle",
    "invalid_configuration",
    "infrastructure_unavailable",
  ].includes(result.status);
}

function isTriggerValidationResult(result: PublicOperationResult): result is ValidateTriggerResult {
  return (
    result.status === "infrastructure_unavailable" ||
    result.status === "invalid_trigger" ||
    (result.status === "valid" && "name" in result)
  );
}

function isTriggerInstallationResult(
  result: PublicOperationResult,
): result is InstallTriggerResult {
  return (
    result.status === "infrastructure_unavailable" ||
    result.status === "invalid_trigger" ||
    (result.status === "installed" && "triggerId" in result)
  );
}

function isProjectsResult(result: PublicOperationResult): result is ListProjectsResult {
  return ["listed", "infrastructure_unavailable"].includes(result.status);
}

function isTriggersResult(result: PublicOperationResult): result is ListTriggersResult {
  return (
    result.status === "infrastructure_unavailable" ||
    (result.status === "listed" && "triggers" in result)
  );
}

function isConfigurationResourcesResult(
  result: PublicOperationResult,
): result is ListConfigurationResourcesResult {
  return (
    result.status === "infrastructure_unavailable" ||
    (result.status === "listed" && "daemons" in result)
  );
}

function isSetupResourcesResult(result: PublicOperationResult): result is ListSetupResourcesResult {
  return (
    result.status === "infrastructure_unavailable" ||
    (result.status === "listed" && "github" in result)
  );
}

function isValidationResult(result: PublicOperationResult): result is ValidateConfigurationResult {
  return [
    "valid",
    "project_not_found",
    "invalid_bundle",
    "invalid_configuration",
    "infrastructure_unavailable",
  ].includes(result.status);
}

function isManualRunResult(result: PublicOperationResult): result is DispatchManualRunResult {
  return [
    "dispatched",
    "project_not_found",
    "actor_forbidden",
    "daemon_offline",
    "expected_configuration_not_current",
    "configuration_not_found",
    "trigger_not_found",
    "invalid_input",
    "dispatch_conflict",
    "infrastructure_unavailable",
  ].includes(result.status);
}

function isEnrollmentResult(result: PublicOperationResult): result is IssueEnrollmentTokenResult {
  return ["issued", "credential_revoked", "infrastructure_unavailable"].includes(result.status);
}

function isRoomsResult(result: PublicOperationResult): result is ListRoomsResult {
  return (
    result.status === "infrastructure_unavailable" ||
    result.status === "room_projection_unavailable" ||
    (result.status === "listed" && "rooms" in result)
  );
}

function isRoomSnapshotResult(result: PublicOperationResult): result is GetRoomSnapshotResult {
  return (
    result.status === "infrastructure_unavailable" ||
    result.status === "room_projection_unavailable" ||
    result.status === "room_not_found" ||
    result.status === "capability_denied" ||
    (result.status === "ok" && "room" in result && "participants" in result)
  );
}

function isRoomEventsResult(result: PublicOperationResult): result is ReplayRoomEventsResult {
  return (
    result.status === "infrastructure_unavailable" ||
    result.status === "room_projection_unavailable" ||
    result.status === "room_not_found" ||
    result.status === "capability_denied" ||
    (result.status === "ok" && "events" in result && "next_cursor" in result)
  );
}

function isControlResult(
  result: PublicOperationResult,
): result is ControlExecutionResult | StartApprovedExecutionResult | GetControlOperationResult {
  return (
    result.status === "infrastructure_unavailable" ||
    result.status === "applied" ||
    result.status === "recorded" ||
    result.status === "replayed" ||
    result.status === "ok" ||
    result.status === "invalid_input" ||
    result.status === "execution_not_found" ||
    result.status === "control_capability_denied" ||
    result.status === "control_precondition_failed" ||
    result.status === "idempotency_key_conflict" ||
    result.status === "control_plane_unavailable" ||
    result.status === "control_operation_not_found" ||
    result.status === "project_not_found" ||
    result.status === "trigger_not_found"
  );
}

function isControlListResult(result: PublicOperationResult): result is ListControlOperationsResult {
  return (
    result.status === "infrastructure_unavailable" ||
    result.status === "control_plane_unavailable" ||
    (result.status === "listed" && "operations" in result)
  );
}

function isExecutionResult(result: PublicOperationResult): result is GetExecutionResult {
  return (
    result.status === "infrastructure_unavailable" ||
    result.status === "execution_control_unavailable" ||
    result.status === "execution_not_found" ||
    result.status === "room_not_found" ||
    result.status === "capability_denied" ||
    (result.status === "ok" && "execution_id" in result)
  );
}

function isExecutionGrantResult(result: PublicOperationResult): result is MintExecutionGrantResult {
  return (
    result.status === "infrastructure_unavailable" ||
    result.status === "execution_control_unavailable" ||
    result.status === "execution_not_found" ||
    result.status === "execution_not_bound" ||
    result.status === "capability_denied" ||
    result.status === "invalid_state" ||
    result.status === "room_not_active" ||
    (result.status === "minted" && "grant_id" in result)
  );
}

function isExecutionActionResult(
  result: PublicOperationResult,
): result is ControlExecutionOperationResult {
  return (
    result.status === "infrastructure_unavailable" ||
    result.status === "execution_control_unavailable" ||
    result.status === "execution_not_found" ||
    result.status === "execution_not_bound" ||
    result.status === "capability_denied" ||
    result.status === "invalid_state" ||
    result.status === "room_not_active" ||
    (result.status === "applied" && "room_seq" in result)
  );
}

export { publicOpenApiDocument } from "./openapi.js";
export { publicOperationManifest } from "./operation-manifest.js";
export * from "./contracts.js";
