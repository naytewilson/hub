# Hub Control Contract V1 (I4) — FROZEN

**Status:** FROZEN — 2026-09-19. Campaign: ANVIL Nervous System Full Integration V1, phase I4.
**Owner:** hub builder. **Consumer:** conduit builder (Wave 3 gate (a)).
**Scope:** `naytewilson/hub` only. No ANVIL, Paseo, SIEVE, gatewayd, or Conduit changes.

This contract is the entire I4 server surface Conduit may build against. Anything not
in this document does not exist. V1 is Hub-owned state only; cross-authority effect
application (I3 converged run-state) is a defined follow-up, not a silent extension.

## 0. Authority model (non-negotiable)

Conduit NEVER mints authority. Every control request passes this fixed pipeline, in
order, on the server:

1. **Transport auth** — `Authorization: Bearer <redacted>` (Paseo organization credential)
   plus API-key scope: `controls:operate` for POSTs, `controls:read` for GETs.
   Missing/revoked → 401; wrong scope → 403 `insufficient_scope`.
2. **Idempotency replay** — `idempotencyKey` is REQUIRED in every POST body.
   Same `(organization, idempotencyKey, op, target)` seen before → the stored result is
   returned byte-identical with HTTP 200 and `"replayed": true`. Same key with a
   DIFFERENT op or target → 409 `idempotency_key_conflict`. Replay skips the
   capability check (the op already executed under a valid grant; the response is the
   stored record — no new authority is exercised).
3. **ANVIL capability check** — the Hub instance's bound ANVIL subject
   (`PASEO_HUB_ANVIL_SUBJECT`) must hold a durable, unrevoked, unexpired grant in
   `anvil.capability_grants` for the op's capability (vocabulary below), evaluated
   through the **read-only** Room projection pool (`default_transaction_read_only=on`).
   Denied → 403 `control_capability_denied`. V1 requires **global** grants
   (`scope_kind = 'global'`); room-scoped control grants are a defined extension for
   when executions carry Room bindings (I1/I3 follow-up).
4. **Target + precondition check** — the target execution must exist in the caller's
   organization and be in an actionable state (matrix below).
   Missing → 404 `execution_not_found`; wrong state → 409 `control_precondition_failed`.
5. **Durable write** — the op is recorded in Hub Postgres (`control_operations`,
   unique on `(organization_id, idempotency_key)`) and its Hub-owned effect is
   applied synchronously. Success HTTP per op: cancel/acknowledge → 200 `applied`;
   retry/resume → 202 `recorded`; start → 201 `applied`.

Hub never writes `anvil.*`. Hub never mints `room_id`, `room_seq`, RoomEvent,
CapabilityGrant, or ExecutionBinding. The read-only pool is the mechanical boundary:
a Hub restart cannot fork Room authority; worst case the control plane answers
`control_plane_unavailable` (503) until the seam is re-established.

## 1. Capability vocabulary

| Op                                          | Required ANVIL capability              |
| ------------------------------------------- | -------------------------------------- |
| resumeExecution                             | `control.resume`                       |
| cancelExecution                             | `control.cancel`                       |
| retryExecution                              | `control.retry`                        |
| acknowledgeAttention                        | `control.acknowledge`                  |
| startApprovedExecution                      | `control.execution_start`              |
| getControlOperation / listControlOperations | (transport scope `controls:read` only) |

Grant row expectations (read, never written, via the Room projection pool):
`capability_grants.capability = 'control.<op>'`, `revoked_at IS NULL`,
`(expires_at IS NULL OR expires_at > now())`, `scope_kind = 'global'`,
subject matched per the H1 predicate (agents by `subject_agent_id` after
`public_id` resolution; device/user by producer-form `subject_ref`).

## 2. Operations

Base path `/api/v1/controls`. All POST bodies are JSON. Field convention: Hub-owned
API uses camelCase (`executionId`, `idempotencyKey`); ANVIL-owned identities passed
through unchanged keep Foundation snake_case (`correlation_id`).

Common POST body fields: `idempotencyKey` (string, 1–64 chars, REQUIRED),
`correlationId` (uuid, optional — I1 spine passthrough, recorded on the op).

### 2.1 cancelExecution — POST /api/v1/controls/executions/{executionId}/cancel

Cancels a live Hub-managed execution.

- **Precondition:** execution exists in the caller's org; `status ∈ {spawning, running}`;
  no `hub_action` already pending. Otherwise 404 / 409.
- **Hub-owned durable effect:** sets `agent_executions.hub_action = 'interrupt'`.
  This is Hub's existing daemon-control signal: the daemon lifecycle
  (`recoverPendingHubActions` / reconcile) picks it up across restarts and issues
  `controlExecution({executionId, action: "interrupt"})` to the daemon, then marks
  the action complete. The op returns 200 `applied` once the signal is durably
  recorded; daemon-side interruption converges asynchronously and is observable
  through the execution's own state.
- **Idempotent:** same key replays the recorded op. A concurrent same-key request
  that loses the `hub_action` update re-reads the key and replays the winner's
  op rather than failing on its own signal.

### 2.2 acknowledgeAttention — POST /api/v1/controls/executions/{executionId}/acknowledge

Acknowledges a daemon attention item on an execution.

- Body: `{ attentionKind: "terminal" | "idle" | "finish_execution_call",
idempotencyKey, correlationId? }` (`executionId` comes from the path; body values
  win on collision).
- **Precondition:** execution exists in the caller's org. Otherwise 404.
- **Kind semantics (frozen):** `terminal` and `idle` are acknowledged client-side
  through the existing acknowledgement state. `finish_execution_call` is
  daemon-side only — a public control request with this kind returns 409
  `control_precondition_failed`.
- **Hub-owned durable effect:** stamps
  `agent_executions.hub_action_acknowledgements[attentionKind]` with the server
  time (monotonic — only moves forward; the existing DB primitive). 200 `applied`.

### 2.3 startApprovedExecution — POST /api/v1/controls/executions/start

Starts an execution through the approved path: the ANVIL `control.execution_start`
grant IS the approval.

- Body: `{ trigger, projectSlug, idempotencyKey, input?, actor?, expectedVersionId?,
correlationId? }` (`trigger`/`projectSlug`/`input`/`actor`/`expectedVersionId`
  mirror the manual-run dispatch shape). `actor` defaults to the calling credential
  ID when omitted or empty.
- **Precondition:** the trigger/project resolves for the caller's org (else
  `project_not_found` / `trigger_not_found`, mirroring manual-run).
- **Hub-owned durable effect:** dispatches through the existing manual-run pipeline
  and records the op with `effect: { triggerRunId, providerEventReceiptId }`.
  The public delivery key is `control-<idempotencyKey>`; the internal dispatch
  `deliveryId` is the deterministic `public-manual-<sha256-base64url(org, project,
key)>` form produced by the manual-run internals (so repeat dispatch with the
  same key collapses to one run). 201 `applied`.

### 2.4 retryExecution — POST /api/v1/controls/executions/{executionId}/retry

### 2.5 resumeExecution — POST /api/v1/controls/executions/{executionId}/resume

- **Precondition:** execution exists in the caller's org; `status = 'failed'`.
  (Resume additionally accepts executions previously cancelled via 2.1, which land
  in `failed` after the daemon reports the interruption.)
- **V1 semantics — intent-recorded:** Hub records the authorized intent durably
  (202 `recorded`) and projects it via §3 for the execution authority to consume.
  Hub applies NO synchronous execution-state change in V1: re-materializing a
  failed execution against the converged run-state machine is owned by the I3
  execution-authority seam, and inventing a Hub-side re-dispatch primitive here
  would fork that authority. The recorded intent carries `effect: { intent: "retry" |
"resume", supersedes: <executionId> }`; when the execution authority applies it,
  the op transitions to `applied` through the same seam (defined follow-up, not in V1).

## 3. Reading ops (projection)

### 3.1 getControlOperation — GET /api/v1/controls/operations/{operationId}

Scope `controls:read`. 200 with the op record; 404 `control_operation_not_found`.

### 3.2 listControlOperations — GET /api/v1/controls/operations

Scope `controls:read`. Query: `executionId?`, `op?`, `status?`, `limit?` (1–200,
default 50). 200 `{ operations: [...], }` ordered by `created_at` desc, `id` desc.
This is the replayable projection surface the execution authority and the I3
convergence owner consume.

### 3.3 Op record shape

```json
{
  "operationId": "uuid (Hub-minted)",
  "op": "resume | cancel | retry | acknowledge | execution_start",
  "status": "recorded | applied",
  "replayed": true, // only on idempotent replay (HTTP 200)
  "idempotencyKey": "client-supplied",
  "executionId": "uuid | null", // target Hub execution (null for start)
  "capability": "control.cancel", // the ANVIL capability that authorized it
  "subject": "machine:anvil-node-01", // bound ANVIL subject label, producer-form
  "correlationId": "uuid | null", // I1 spine passthrough
  "effect": { "hubAction": "interrupt" }, // per-op, see §2
  "createdAt": "iso8601",
  "updatedAt": "iso8601"
}
```

## 4. Status → HTTP map

| Result status                             | HTTP    | Meaning                                                                 |
| ----------------------------------------- | ------- | ----------------------------------------------------------------------- |
| `applied`                                 | 200     | Op durably recorded; Hub-owned effect applied synchronously             |
| `recorded`                                | 202     | Op durably recorded; effect application owned downstream (retry/resume) |
| `replayed`                                | 200     | Idempotent replay of the stored result                                  |
| `execution_not_found`                     | 404     | No execution with that id in the caller's org                           |
| `control_operation_not_found`             | 404     | No op with that id in the caller's org                                  |
| `control_capability_denied`               | 403     | Bound ANVIL subject lacks the durable `control.<op>` grant              |
| `insufficient_scope`                      | 403     | Bearer <redacted> lacks `controls:operate` / `controls:read`            |
| `control_precondition_failed`             | 409     | Target exists but is not actionable (`reason` in body)                  |
| `idempotency_key_conflict`                | 409     | Key reused with a different op or target                                |
| `project_not_found` / `trigger_not_found` | 404/409 | startApprovedExecution target resolution (mirrors manual-run)           |
| `control_plane_unavailable`               | 503     | ANVIL Room seam unconfigured (`room_projection_unavailable` equivalent) |
| `infrastructure_unavailable`              | 503     | Hub auth/storage unavailable                                            |

All error bodies are RFC 7807-style problems with a stable `type` code (the status
string), matching the existing public-API problem shape.

## 5. What V1 explicitly does NOT do

- No synchronous daemon termination beyond the recorded `interrupt` signal (§2.1).
- No re-dispatch / re-materialization primitive for retry/resume (I3 seam owns it).
- No room-scoped control grants (global only; extension defined).
- No control over Paseo-native agent lifecycle outside Hub-managed executions.
- No writes to any `anvil.*` table, ever — the read-only pool makes this mechanical.
- No Conduit client code, no UI. Conduit consumes this contract; it does not shape it.

## 6. Conduit integration notes (non-normative)

- Mint one `idempotencyKey` (uuid) per user gesture; persist it across app restarts
  and retry the same key — the server replays rather than double-applies.
- Poll `GET /api/v1/controls/operations/{operationId}` for op status; use
  `listControlOperations?executionId=` to rebuild control history after a restart.
- Treat `recorded` (retry/resume) as "authorized and queued with the execution
  authority", not "the agent is running again".
- Never cache a 403: re-check capability after the operator provisions the grant.
