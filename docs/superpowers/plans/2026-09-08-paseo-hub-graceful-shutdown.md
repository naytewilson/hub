# Paseo Hub Graceful Shutdown Repair V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the production Paseo Hub stop its listener and application runtime in a bounded, graceful order, including a bounded WebSocket close fallback, and prove the repair on the live HP service with Dell and Neo connected.

**Architecture:** Initiate HTTP listener shutdown immediately so no new work is accepted, then stop the application runtime while the listener-close promise waits in parallel. The daemon registry will perform a graceful close handshake and terminate an uncooperative socket after a fixed short deadline, while preserving offline-presence and pending-request cleanup. A focused test fixture will prove each wait independently; the candidate will be built on Dell, deployed to the existing HP package target without changing topology or data, and verified through a real systemd stop/restart.

**Tech Stack:** TypeScript, Node.js `node:http`, `ws`, Vitest, npm build/package scripts, user systemd, Tailscale SSH, ANVIL MCP, Google Drive Sheets/Files.

**Spec:** `/tmp/codex-remote-attachments/01a07ecf-7848-7b02-99bb-9d130466ec22/A57638F8-62D2-47FF-A87E-4F1702EE8B52/1-PASEO_HUB_GRACEFUL_SHUTDOWN_REPAIR_V1.toon`

## Global Constraints

- Keep HP as the single authoritative Hub and model-plane host, Dell as the default general Paseo execution host, and Neo as the thin Apple execution node.
- Do not increase `TimeoutStopSec` or disable `TimeoutStopFailureMode=abort` as the repair; do not mask coredumps or use process-wide `SIGKILL` as the normal stop path.
- Do not stop Dell or Neo before every Hub restart, change the three-node topology, move the Hub, install a container runtime, or recreate OpenViking or deleted migration-only trees.
- Do not edit the installed HP package without a source-controlled patch, pushed user-owned branch, exact build/package provenance, and a rollback target.
- Build and run heavy tests on Dell; use HP only for bounded runtime validation and the final candidate service; use Neo only to verify its thin Apple execution path.
- Preserve startup behavior, embedded database persistence, API compatibility, daemon reconnection, Tailscale identities/routes/Serve entries, unrelated services, and all credential/key secrecy.
- Treat hosted CI as unavailable by default; run applicable local non-container tests and record any container-backed suite as `BLOCKED_BY_ENVIRONMENT` if no compatible runtime already exists.
- Required evidence labels are `PROVEN`, `OBSERVED`, `INFERRED`, `UNKNOWN`, `FALSIFIED`, and `BLOCKED`; historical receipts do not replace live checks.

---

### Task 0: Reacquire source truth and localize every shutdown wait

**Files:**

- Read: `src/index.ts:300-370`
- Read: `src/server/runtime.ts:136-160`
- Read: `src/application-runtime.ts:48-120,350-360`
- Read: `src/composition-resources.ts:1-32`
- Read: `src/app.ts:117-255`
- Read: `src/daemons/registry.ts:98-150,232-250`
- Read: `src/daemons/lifecycle.ts:174-190`
- Read: `src/workflows/engine.ts:117-130`
- Create temporarily: `/tmp/paseo-hub-shutdown-stage-repro.mjs` (delete after evidence is captured)
- Create temporarily: `/tmp/paseo-hub-registry-repro.mjs` (delete after evidence is captured)
- Create: `/home/nayte/ANVIL/universal-dell-workspace-harness/runs/20260908T035452Z-paseo-hub-graceful-shutdown/evidence/hub-shutdown-prefix.json`

**Interfaces:**

- Consumes: `createFetchServer`, `ActiveDaemonRegistry`, the live HP unit `anvil-fabric-hub.service`, and the current Active Pointers/Hub Registry rows.
- Produces: a source/ref receipt showing current upstream main, live service/package/data configuration, and two deterministic pre-fix timings: HTTP `server.close()` waits while an upgraded WebSocket is open, and `ActiveDaemonRegistry.stop()` remains pending for a peer that never emits `close`.
  - [x] **Step 1: Re-fetch and verify the exact source and live authorities.**

  Run on Dell:

  ```bash
  git -C /home/nayte/ANVIL-worker/repos/paseo-hub-graceful-shutdown-20260908 fetch --prune upstream
  git -C /home/nayte/ANVIL-worker/repos/paseo-hub-graceful-shutdown-20260908 show -s --format='%H%n%s' upstream/main
  git -C /home/nayte/ANVIL-worker/repos/paseo-hub-graceful-shutdown-20260908 status --short --branch
  ```

  Read the native Drive ranges for `PASEO_HUB_CONTROL_PLANE`, `ANVIL_THREE_NODE_MODEL_PLANE`, `DELL_GENERAL_EXECUTION_PLANE` when present, and `NEO_APPLE_EXECUTION_PLANE`. Through stable Tailscale names, capture HP Hub unit/package/data hashes and active state, Dell/Neo daemon IDs and connected state, and a fresh ANVIL status/ownership snapshot.
  - [x] **Step 2: Run the HTTP-order reproduction against the current source path.**

  The temporary script must use `createFetchServer` and `ws` to keep one upgraded socket open, then execute the current ordering below with a one-second observation deadline. The runtime callback is intentionally invoked only after the listener callback, so a pending listener close proves the old ordering can deadlock:

  ```js
  const listenerClosed = new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await listenerClosed;
  await stopRuntime();
  ```

  Record that `stopRuntime()` has not started while `listenerClosed` is pending, then close the fixture socket and record the callback completion. Keep the script outside Git and remove it after copying its JSON result into the repair evidence.
  - [x] **Step 3: Run the registry-order reproduction with a non-cooperative peer.**

  Instantiate `ActiveDaemonRegistry` with an in-memory database stub and an EventEmitter-shaped WebSocket whose `readyState` is `WebSocket.OPEN`, whose `close()` records the request without emitting `close`, and whose `terminate()` is absent for the pre-fix run. Call `registry.stop()` and race it against 100 ms. Record `pending_after_100ms=true` and the requested close code/reason. Run the existing cooperative `src/daemons/registry.test.ts` baseline as well.
  - [x] **Step 4: Save the pre-fix evidence and stop before implementation.**

  The evidence JSON must include `sourceRef`, `listenerCloseWaitMs`, `runtimeStartedBeforeListenerClosed`, `registryStopSettledWithin100ms`, exact test commands, and labels explaining that the two reproductions identify the waits but do not yet claim a root cause for other owned resources. Do not edit production or source files in this task.

### Task 1: Add failing focused lifecycle regressions

**Files:**

- Modify: `src/index.ts:1-24,330-346`
- Create: `src/index.shutdown.test.ts`
- Modify: `src/daemons/registry.ts:98-250`
- Modify: `src/daemons/registry.test.ts` near the existing shutdown tests

**Interfaces:**

- Consumes: Task 0’s two pre-fix reproductions and the existing `ActiveDaemonRegistry` constructor/`stop()` API.
- Produces: deterministic tests that fail against the old implementation: a production shutdown helper test that requires runtime stopping to begin before the listener close callback, and a registry test with a non-cooperative socket that requires bounded completion.
  - [x] **Step 1: Write the failing production ordering test.**

  Add an exported testable helper with this signature to `src/index.ts`:

  ```ts
  interface ProductionServer {
    close(callback: (error?: Error) => void): unknown;
    closeIdleConnections?(): void;
  }

  export function stopProductionServer(
    server: ProductionServer,
    stopRuntime: () => Promise<void>,
  ): Promise<void>;
  ```

  In `src/index.shutdown.test.ts`, use a deferred fake `Server` whose `close` callback is released only when the runtime stop runs. Assert that the call settles and that the event order begins with listener shutdown, then runtime stop, then listener callback. The old code awaits the callback before invoking the runtime and therefore leaves this test pending.
  - [x] **Step 2: Run only the new ordering test and record the expected failure.**

  ```bash
  npm exec vitest run src/index.shutdown.test.ts --reporter=verbose
  ```

  Expected result before implementation: the test times out or reports that the runtime was never started while the listener callback was deferred. Do not weaken the timeout to make the old sequence pass.
  - [x] **Step 3: Write the failing non-cooperative registry test.**

  Add a fixture socket to `src/daemons/registry.test.ts` that emits `message`/`close` handlers, reports `WebSocket.OPEN`, records `close(1001, "server shutdown")`, and only changes state when `terminate()` is called. Construct the registry with a 10 ms injected close deadline, call `stop()`, and assert that it settles after the fallback and that `terminate()` was called. The current implementation has no deadline or fallback, so this test must fail by timeout.
  - [x] **Step 4: Run the registry regression alone and preserve the failure output.**

  ```bash
  npm exec vitest run src/daemons/registry.test.ts --reporter=verbose
  ```

  Expected result before implementation: the non-cooperative shutdown test remains pending until Vitest’s test timeout. Existing cooperative protocol and presence tests must continue to pass.

### Task 2: Implement the minimal bounded graceful lifecycle

**Files:**

- Modify: `src/index.ts:1-24,330-346`
- Modify: `src/daemons/registry.ts:98-250`
- Modify: `src/daemons/registry.test.ts`
- Modify: `src/index.shutdown.test.ts`

**Interfaces:**

- Consumes: the failing tests from Task 1 and the existing `BuiltStartServer.stopProductionRuntime`, `ActiveDaemonRegistry.stop`, and `CompositionResources.close` contracts.
- Produces: `stopProductionServer(server, stopRuntime)` that initiates listener close and runs runtime shutdown concurrently, plus `ActiveDaemonRegistry.stop()` that performs a graceful close followed by a per-socket terminate fallback at a fixed default deadline (5 seconds in production, injectable for tests).
  - [x] **Step 1: Implement listener-first, runtime-concurrent shutdown.**

  Create the listener-close promise, call `server.close()` before awaiting anything, close idle HTTP connections through the existing Node method, and await both the listener promise and `stopRuntime()` with `Promise.all`. Replace the inline `main()` stop closure with `stopProductionServer(server, build.stopProductionRuntime)`. Do not force-close active requests, call `process.kill`, alter systemd timeouts, or change endpoint/configuration behavior.
  - [x] **Step 2: Implement bounded WebSocket close.**

  Add a `DAEMON_SOCKET_CLOSE_TIMEOUT_MS = 5_000` constant and an optional constructor argument used only as a test override. For every active socket, resolve immediately if already closed; otherwise attach one idempotent `close` listener, call `close(1001, "server shutdown")`, and schedule a timeout. On timeout call that socket’s `terminate()` and resolve the socket wait without using a process-wide signal. Keep awaiting all observed `presenceWrites` and reject all pending RPC requests after socket waits, preserving the current offline-presence semantics.
  - [x] **Step 3: Run the focused regressions and inspect lifecycle ordering.**

  ```bash
  npm exec vitest run src/index.shutdown.test.ts src/daemons/registry.test.ts --reporter=verbose
  ```

  Expected result: all new tests and all existing tests in those files pass; the event trace proves listener close is initiated before runtime stop, and a non-cooperative socket is terminated at the injected deadline.
  - [x] **Step 4: Run the existing Hub shutdown-bound test.**

  ```bash
  npm exec vitest run src/daemons/daemons.test.ts -t "bounds Hub shutdown" --reporter=verbose
  ```

  Expected result: PASS in under 30 seconds, with the existing residual-exposure contract unchanged.

### Task 3: Full local verification, build, package, and source-control

**Files:**

- Modify: only the source/test files listed in Task 2
- Create: Dell-side candidate package in `runs/20260908T035452Z-paseo-hub-graceful-shutdown/artifacts/`
- Modify: `docs/superpowers/plans/2026-09-08-paseo-hub-graceful-shutdown.md` checkboxes

**Interfaces:**

- Consumes: the passing focused lifecycle tests and unchanged package scripts in `package.json`.
- Produces: typecheck/lint/format/build evidence, package tarball SHA-256, changed-file list, and a pushed `fix/graceful-shutdown-20260908` commit on `naytewilson/hub`.
  - [x] **Step 1: Run applicable non-container gates on Dell.**

  ```bash
  npm exec vitest run src/index.shutdown.test.ts src/daemons/registry.test.ts src/daemons/daemons.test.ts --reporter=verbose
  npm run typecheck
  npm run lint
  npm run format:check
  npm run build
  ```

  Record command exit codes and durations. Do not install Docker, Podman, or another runtime; if the 94-test container-backed suite cannot run, record `BLOCKED_BY_ENVIRONMENT` with the observed missing runtime.
  - [x] **Step 2: Pack the exact built candidate and bind bytes to the commit.**

  ```bash
  git rev-parse HEAD
  npm pack --pack-destination /home/nayte/ANVIL/universal-dell-workspace-harness/runs/20260908T035452Z-paseo-hub-graceful-shutdown/artifacts
  sha256sum /home/nayte/ANVIL/universal-dell-workspace-harness/runs/20260908T035452Z-paseo-hub-graceful-shutdown/artifacts/getpaseo-hub-0.9.0.tgz
  ```

  Save the tarball path, commit SHA, package filename, package SHA-256, build command, and changed-file list. Confirm the package contains `dist`, `.output`, `bin`, and `drizzle` and contains no credentials.
  - [x] **Step 3: Commit and push the user-owned branch.**

  ```bash
  git add src/index.ts src/index.shutdown.test.ts src/daemons/registry.ts src/daemons/registry.test.ts docs/superpowers/plans/2026-09-08-paseo-hub-graceful-shutdown.md
  git commit -m "fix: bound Hub graceful shutdown"
  git push -u origin fix/graceful-shutdown-20260908
  git rev-parse HEAD
  git ls-remote origin refs/heads/fix/graceful-shutdown-20260908
  ```

  Do not force-push or modify upstream `main`. The remote SHA must equal the local commit SHA before deployment.

### Task 4: Deploy and prove the candidate on HP with Dell and Neo connected

**Files/artifacts:**

- Read: HP user unit `~/.config/systemd/user/anvil-fabric-hub.service` and its drop-ins
- Read: existing HP package target and `/home/nayte/.local/share/anvil-service-fabric/20260908/hub09-production-data`
- Create: `runs/20260908T035452Z-paseo-hub-graceful-shutdown/evidence/hp-hub-predeploy.json`, `hp-stop-repair.json`, `hp-restart-repair.json`

**Interfaces:**

- Consumes: Task 3’s pushed commit and package SHA, the unchanged HP service environment, and live Dell/Neo daemon connections.
- Produces: real systemd stop duration/final state, no validation-window SIGABRT/coredump, successful restart on the same data directory, reconnects, OpenAPI response, and fresh Dell/Neo PONG agent IDs.

- [ ] **Step 1: Snapshot the exact HP Hub rollback target.**

  Through `tailscale ssh anvil-node-01.tail530013.ts.net`, capture the unit text/hash, drop-in text/hash, ExecStart package path/hash, data-directory identity, endpoint, and active PID. Capture Dell/Neo daemon IDs and Hub-connected status immediately before deployment. Do not touch FreeLLMAPI, eligibility, echo, model Serve, Tailscale, OpenViking, or deleted snapshot trees.

- [ ] **Step 2: Transfer and install only the candidate Hub package target.**

  Transfer the Dell-built tarball to a new non-live staging path on HP, verify the tarball SHA-256 there, and install it into the existing Hub package target while retaining the same unit, environment, endpoint, and data directory. Keep the predeploy package path available for rollback; do not create migration archives or OpenViking data.

- [ ] **Step 3: Verify both daemons are connected, then stop the exact unit.**

  Run a timed command on HP with no changed timeout:

  ```bash
  started_ns=$(date +%s%N)
  systemctl --user stop anvil-fabric-hub.service
  rc=$?
  finished_ns=$(date +%s%N)
  printf 'rc=%s elapsed_ms=%s\n' "$rc" "$(( (finished_ns - started_ns) / 1000000 ))"
  systemctl --user show anvil-fabric-hub.service -p ActiveState -p SubState -p Result -p ExecMainStatus -p NRestarts
  ```

  Require a successful inactive/dead result before 45 seconds, target normally under 10 seconds, and no new Hub coredump or `SIGABRT` in the exact stop journal window. Preserve the raw command output and journal timestamps.

- [ ] **Step 4: Start the same service and prove data/API continuity.**

  Start `anvil-fabric-hub.service` with the existing unit and data directory. Require active/running, `/api/openapi.json` HTTP 200, unchanged embedded database identity/row continuity, and the same endpoint. Capture the new PID and startup logs without modifying model services.

- [ ] **Step 5: Prove Dell and Neo reconnect without pre-stopping either daemon.**

  Verify each stable-name Paseo daemon is connected to the HP Hub, then run a fresh Free Pool PONG request on Dell and a fresh Free Pool PONG request on Neo. Record each fresh agent ID, request/response status, and Hub execution evidence. Confirm `app.paseo.sh` still presents Dell as the default general host and Neo as the thin Apple host through read-only checks.

- [ ] **Step 6: Roll back only if candidate runtime gates fail.**

  If startup, persistence, reconnection, or model access fails, stop the candidate, restore the exact predeploy package target and unchanged unit/data configuration, start it, and capture the failure. Continue source debugging on Dell; never change topology or recreate deleted migration artifacts.

### Task 5: Durable receipt, Drive pointer, ANVIL decision, and closeout

**Files:**

- Create: `runs/20260908T035452Z-paseo-hub-graceful-shutdown/receipts/BATTLE_REPORT.md`
- Create: `runs/20260908T035452Z-paseo-hub-graceful-shutdown/receipts/BATTLE_REPORT.sha256`
- Create: `runs/20260908T035452Z-paseo-hub-graceful-shutdown/receipts/DRIVE_PUBLICATION.json`
- Create: `runs/20260908T035452Z-paseo-hub-graceful-shutdown/evidence/` files listed above

**Interfaces:**

- Consumes: Tasks 0–4 evidence, local test/build/package output, pushed branch SHA, and the existing Drive Active Pointers/Hub Registry IDs.
- Produces: a hash-verified Battle Report with one of the exact verdicts `HUB_GRACEFUL_SHUTDOWN_REPAIRED` or `PARTIAL_WITH_EXACT_BLOCKER`, Drive report/sidecar IDs, a read-back pointer update limited to `PASEO_HUB_CONTROL_PLANE`, and an ANVIL event read-back.

- [ ] **Step 1: Assemble the twelve required receipt sections.**

  Write `BATTLE_REPORT.md` with these exact headings and concrete evidence: `PROVEN`, `MISSING EVIDENCE`, `POSSIBLY WRONG OR OVERSTATED`, `SOURCE TRUTH INSPECTED`, `ROOT CAUSE`, `CHANGED FILES`, `TESTS AND BUILD`, `HP LIVE LIFECYCLE PROOF`, `DELL AND NEO POST-RESTART PROOF`, `GIT REF AND PACKAGE HASH`, `DRIVE PUBLICATION`, and `EXACT NEXT ACTION`. Include pre-fix timing, post-fix focused test, HP stop duration/final state, coredump-window result, OpenAPI 200, persisted state read-back, Dell PONG agent ID, Neo PONG agent ID, branch/commit, package SHA-256, report SHA-256, and Drive IDs with evidence labels.

- [ ] **Step 2: Hash and publish the receipt.**

  ```bash
  sha256sum runs/20260908T035452Z-paseo-hub-graceful-shutdown/receipts/BATTLE_REPORT.md > runs/20260908T035452Z-paseo-hub-graceful-shutdown/receipts/BATTLE_REPORT.sha256
  sha256sum -c runs/20260908T035452Z-paseo-hub-graceful-shutdown/receipts/BATTLE_REPORT.sha256
  ```

  Upload the report and sidecar to the canonical Dell evidence folder, then read both file metadata records back. Do not upload credentials, raw auth headers, or private key material.

- [ ] **Step 3: Update only the Hub Active Pointer after receipt verification.**

  Use native Google Sheets batch update on spreadsheet `1VELPIXR1wjOCZdUFjd0xE7yLyF0lJBaUPmZYH2n99cI`, tab `Sheet1`, updating only the `PASEO_HUB_CONTROL_PLANE` row’s observed receipt reference/hash/verdict. Read back that row plus `ANVIL_THREE_NODE_MODEL_PLANE` and `NEO_APPLE_EXECUTION_PLANE` to prove placement was preserved. Do not rewrite unrelated provider or topology rows.

- [ ] **Step 4: Record and read back the ANVIL closure decision.**

  Through the canonical ANVIL MCP wrapper, record the repair verdict, source commit, package SHA, HP stop duration, and report SHA, then read the event log by returned event ID. Treat the event read-back as `PROVEN` only when the exact ID and fields match.

- [ ] **Step 5: Run the universal final gate and close with the exact next action.**

  Run `./scripts/final-gate.sh /home/nayte/ANVIL-worker/repos/paseo-hub-graceful-shutdown-20260908` and include its result as hygiene evidence separate from the Hub lifecycle gates. Mark the verdict repaired only when the real HP stop is clean and normally under 10 seconds, all post-restart gates pass, focused tests pass, and the pushed source/package/receipt/pointer hashes agree. Otherwise mark `PARTIAL_WITH_EXACT_BLOCKER` and name the remaining blocker precisely.
