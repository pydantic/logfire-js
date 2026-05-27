## Goal

Refine Node process signal and fatal/error handlers so they use bounded best-effort lifecycle helpers, never throw, and preserve expected process termination behavior where Logfire itself installs the process listener that changes Node's default behavior.

This PRP depends on:

- PRP 002: complete Node lifecycle flush/shutdown (provides the bounded best-effort helpers and `shutdownPromise` reentrancy guard this PRP builds on).

This PRP is intentionally scoped to:

- `beforeExit`, `uncaughtExceptionMonitor`, `unhandledRejection`, and `SIGTERM` handler refinement in Node
- Tests that exercise handler behavior without terminating the test runner

Out of scope:

- Browser and Cloudflare runtime parity, covered by PRP 005
- Tail sampling, pending spans, or exporter behavior
- Adding broad `SIGINT` handling. Ctrl-C behavior is interactive/development UX and should remain Node/default/user-owned for now.
- Fully changing `unhandledRejection` fatal semantics. This PRP records the current behavior and makes the handler best-effort/no-throw, but a breaking change to restore Node's default fatal behavior should be handled as a separate product decision.

## Why

- Node signal handlers change default process behavior. Once the SDK installs a `SIGTERM` listener, Node no longer terminates by default on that signal — the handler must ensure termination after best-effort flush.
- Process handlers run during sensitive states (shutdown, crash). An exception inside a handler can mask the original cause of termination or prevent flush.
- The current handlers were added in PRP 002 with the lifecycle helpers in mind, but did not finalize the signal-termination semantics or the fatal-handler best-effort path.
- This is the only piece in the runtime-parity sweep that can introduce production regressions (orphaned processes, supervisor restart loops, lost stdout buffers). It deserves a focused review pass.
- Established Node shutdown libraries support a narrow, default-preserving approach: observe exits only when they would exit (`signal-exit`), perform bounded cleanup before termination (`close-with-grace`), and prefer re-sending the received signal over unconditional `process.exit()` when preserving signal semantics (`@godaddy/terminus`).

## Success Criteria

- [x] `beforeExit` uses a bounded best-effort shutdown that never throws.
- [x] `uncaughtExceptionMonitor` reports the error (existing behavior) and then schedules a bounded best-effort flush of all tracked telemetry paths (spans, logs, metrics) without throwing.
- [x] `unhandledRejection` reports the error (existing behavior) and then triggers a bounded best-effort flush without throwing.
- [x] `SIGTERM` snapshots listener state before shutdown, performs bounded best-effort shutdown, then removes Logfire's listener and re-emits `SIGTERM` with `process.kill(process.pid, 'SIGTERM')` when Logfire is the only `SIGTERM` listener.
- [x] `SIGTERM` performs bounded best-effort shutdown but does not force process exit when user `SIGTERM` listeners are also installed.
- [x] Logfire does not install a new `SIGINT` listener in this PRP.
- [x] No handler throws under any code path; failures are logged via `diag.warn`/`diag.error` and swallowed.
- [x] Tests cover the signal/error-handler behavior without actually terminating the test runner.
- [x] Existing PRP 002 reentrancy guarantee (one shutdown promise per runtime) still holds when handlers fire concurrently or repeatedly.

## Clarifications

### Session 2026-05-27

- Q: Which established libraries should inform the design? -> A: Use `signal-exit`, `@godaddy/terminus`, and `close-with-grace` as design references only, not dependencies.
- Q: How should `SIGTERM` preserve termination after best-effort shutdown? -> A: If Logfire is the only `SIGTERM` listener, remove Logfire's listener and re-emit `SIGTERM`, matching `signal-exit`/Terminus-style default-preserving behavior. If user `SIGTERM` listeners also exist, Logfire should flush/shutdown and return; app-level lifecycle code owns termination in that case.
- Q: Should `SIGINT` be handled in this PRP? -> A: No. Leave Ctrl-C behavior alone for now to avoid surprising interactive/development workflows.
- Q: Should process-hook flushes include only spans or all Logfire-managed telemetry paths? -> A: Use all PRP 002 paths: spans, pending spans, evals, logs, metrics, and configured additional processors/readers.
- Q: Should this PRP restore Node's default fatal behavior for `unhandledRejection`? -> A: No, not in this PRP. The POC proves current Logfire suppresses Node's default fatal behavior, but restoring it is a broader behavior change. This PRP should keep existing reporting behavior, make the handler bounded/no-throw, document the finding, and leave the fatal-semantics change for a separate explicit decision.

### POC Results 2026-05-27

Ran `node scripts/poc-node-process-handlers.mjs` against the locally built `packages/logfire-node/dist/index.js`.

Signal findings:

- Baseline Node exits on `SIGTERM` with `signal=SIGTERM`.
- Current Logfire installs one `SIGTERM` listener and the child remains alive after `SIGTERM`; this confirms the current handler suppresses default termination.
- A generic `SIGTERM` listener that does not terminate also keeps the process alive; this confirms the behavior is not Logfire-specific, it is Node listener semantics.
- Removing Logfire's listener and re-emitting `SIGTERM` exits with `signal=SIGTERM` when Logfire is the only listener. The working mechanism is `process.kill(process.pid, 'SIGTERM')`, not `process.emit('SIGTERM')`.
- Re-emitting does not preserve termination if a user `SIGTERM` listener remains installed; the user listener receives the re-emitted signal and the process stays alive.
- Explicit `process.exit(143)` exits even with a listener, but loses signal-style exit reporting and carries the stdout/stderr truncation risk noted in Node docs.

Unhandled rejection findings:

- Baseline Node exits with code `1` for an unhandled rejection under the local Node 24 runtime.
- A generic `unhandledRejection` listener keeps the process alive.
- Current Logfire installs one `unhandledRejection` listener and the child remains alive after an unhandled rejection; this means the current handler changes Node's default fatal behavior.

Implementation implications:

- `SIGTERM` handling should distinguish "Logfire is the only signal listener" from "user signal listeners are also installed". Re-emit is the closest default-preserving behavior in the first case. Forcing `process.exit(128 + signal)` is the only reliable termination path in the second case, but is too invasive for this SDK by default.
- `SIGINT` should stay out of this PRP; Ctrl-C cleanup can be revisited separately if product wants that UX tradeoff.
- `unhandledRejection` needs a separate explicit product decision. Keeping a listener preserves current Logfire behavior but suppresses Node's default fatal behavior. Preserving Node behavior likely means avoiding a plain `unhandledRejection` listener, or explicitly rethrowing/exiting after best-effort telemetry.

Review follow-up:

- The `SIGTERM` listener-state decision must be made at handler entry, before calling `shutdownRuntime()`, because `shutdownRuntime()` removes process listeners synchronously before awaiting SDK shutdown. Checking listeners after shutdown would lose the information needed to decide whether Logfire was the only listener when the signal arrived.
- `uncaughtExceptionMonitor` is observe-only. In a real uncaught-exception crash, async flush work scheduled from this hook usually will not complete before Node exits. Keep the scheduled best-effort flush because it is useful in mixed-handler/test scenarios, but do not treat tests as proof of production flush completion for true crashes.

## Context

### Key Files

- `packages/logfire-node/src/sdk.ts` - Node process handlers and best-effort lifecycle helpers from PRP 002 (see `forceFlushBestEffort`, `flushRuntime`, `shutdownRuntime`).
- `packages/logfire-node/src/__test__/sdk.test.ts` - Node process listener tests.
- `packages/logfire-node/README.md` - documentation of process handler behavior.

### Python Reference

- `../logfire/logfire/_internal/config.py` - AWS Lambda flush hook and process-exit flushing patterns. Python does not install signal handlers by default; this is a JS-specific concern driven by Node's signal semantics.

### Gotchas

- Once the SDK installs a `SIGTERM` listener, Node no longer terminates by default. When Logfire is the only `SIGTERM` listener, the handler MUST restore default-style termination by removing Logfire's listener and re-emitting `SIGTERM`.
- Snapshot `SIGTERM` listener state before calling `shutdownRuntime()`. `shutdownRuntime()` calls `removeProcessListeners(runtime)` synchronously, so checking `process.listeners('SIGTERM')` after shutdown starts is too late.
- Re-emit the signal with `process.kill(process.pid, 'SIGTERM')`. Do not use `process.emit('SIGTERM')`; that only invokes JS listeners and will not produce signal-style process termination.
- Re-emitting `SIGTERM` is not enough when user `SIGTERM` listeners remain installed; Node still sees a handled signal. In that case Logfire must not re-emit or force-exit by default because it would take ownership of app lifecycle policy and may deliver the signal to user handlers twice.
- Calling `process.exit()` from inside an async handler can drop stdout/stderr buffers and unflushed file descriptors. Do not use `process.exit()` for the default PRP 006 path.
- `uncaughtExceptionMonitor` is the right hook for "observe, don't prevent crash" — it does NOT suppress the default crash behavior. If anyone changes it to `uncaughtException`, the process semantics flip silently (the process no longer crashes). Add a comment guarding this if necessary.
- `uncaughtExceptionMonitor` cannot guarantee async telemetry flush completion during a real uncaught-exception crash. It can only schedule a best-effort flush before Node continues its default crash path.
- Handlers can re-enter: a `SIGTERM` arriving during a `beforeExit`-triggered shutdown should not start a second shutdown. The existing `shutdownPromise` cache in `shutdownRuntime` handles this; signal handlers must call through that path rather than reaching past it.
- Tests must stub `process.kill` or the handler internals to avoid terminating the test runner. Do NOT emit real signals via `process.kill(process.pid, ...)` in tests.
- The current `beforeExit` handler uses an `_shutdown` flag (`sdk.ts:301`) that lives outside the `shutdownPromise` mechanism. Unify these so reentrancy guarantees are not split across two state machines.
- The current `unhandledRejection` listener suppresses Node's default fatal behavior. This PRP does not change that semantic behavior; do not accidentally claim parity with Node defaults in docs.
- Logfire does not hook `process.on('exit', ...)` in this PRP. The `exit` event is synchronous and cannot complete async telemetry flush.

## Implementation Blueprint

### Tasks

```yaml
Task 1: Refine handlers in sdk.ts
  MODIFY packages/logfire-node/src/sdk.ts:
    - `beforeExit`: route through the same bounded best-effort path used by other handlers; delete the local `_shutdown` flag and rely on the `shutdownPromise` cache so there is one reentrancy guard.
    - `uncaughtExceptionMonitor`: keep the existing error-report call, then schedule bounded best-effort flush of all Logfire-managed telemetry paths. Do not claim this flush reliably completes before a real uncaught-exception crash.
    - `unhandledRejection`: keep the existing error-report call and current process semantics, then trigger bounded best-effort flush of all Logfire-managed telemetry paths.
    - `SIGTERM`: bounded best-effort shutdown, then:
      - snapshot signal listener state at handler entry before calling `shutdownRuntime()`.
      - classify the entry snapshot with `process.listeners('SIGTERM')` and reference equality against `listeners.SIGTERM`:
        - `logfire-only`: listeners length is 1 and the only listener is Logfire's `SIGTERM` closure.
        - `user-listeners-present`: Logfire's listener is present with any additional listener(s).
        - `logfire-missing-no-others`: listeners length is 0, meaning another lifecycle path already removed Logfire's listener and no user listener is present.
        - `logfire-missing-with-others`: one or more listeners remain, but none is Logfire's `SIGTERM` closure.
      - re-emit iff the entry snapshot state is `logfire-only` or `logfire-missing-no-others`.
      - if state is `logfire-only`, call bounded shutdown (which removes Logfire's listener as part of cleanup), then re-emit with `process.kill(process.pid, 'SIGTERM')`.
      - if state is `logfire-missing-no-others`, call/await the shared bounded shutdown path and then re-emit with `process.kill(process.pid, 'SIGTERM')`, because the original signal would otherwise be swallowed after another lifecycle trigger removed listeners.
      - if state is `user-listeners-present` or `logfire-missing-with-others`, do not re-emit or force-exit; log/debug that app-level signal handlers own termination.
    - Do not install a `SIGINT` listener in this PRP.
    - Wrap every handler body in a try/catch that routes failures through `diag.warn`/`diag.error` and never rethrows.
    - Factor small internal helpers (`bestEffortLifecycle(runtime, reason)`, `terminateAfterFlush(signal, runtime)`, `getLogfireSignalListenerState(signal, listener)`) so tests can call or observe them indirectly.

Task 2: Tests
  MODIFY packages/logfire-node/src/__test__/sdk.test.ts:
    - Assert each handler calls the bounded best-effort lifecycle helper exactly once even when invoked repeatedly.
    - Assert handler failures are swallowed and surfaced via diag.
    - Assert `SIGTERM` listener state is snapshotted before shutdown removes process listeners by arranging shutdown to remove listeners synchronously and then block on an unresolved promise; the handler decision must still reflect the entry snapshot, not the post-removal listener list.
    - Assert `SIGTERM` termination preservation by stubbing `process.kill` and verifying it is invoked after flush settles when Logfire is the only SIGTERM listener.
    - Assert `SIGTERM` uses `process.kill(process.pid, 'SIGTERM')`, not `process.emit('SIGTERM')`.
    - Assert `SIGTERM` does not call `process.kill` when another user SIGTERM listener is present.
    - Assert `SIGTERM` re-emits when the Logfire listener is already absent and no other SIGTERM listener is present at handler entry because another lifecycle trigger started shutdown first.
    - Assert `SIGTERM` does not call `process.kill` when the Logfire listener is already absent but user SIGTERM listeners remain.
    - Assert no `SIGINT` listener is installed by Logfire.
    - Assert `unhandledRejection` retains current process-listener behavior while using the bounded no-throw best-effort flush path.
    - Assert `uncaughtExceptionMonitor` schedules best-effort flush without throwing; do not assert real-crash flush completion.
    - Assert reentrancy: concurrent invocations share the same shutdown promise.
    - Assert `start()` called twice leaves only the latest runtime's listeners installed, and SIGTERM goes through the latest listener/runtime.
    - Do NOT emit real signals against `process.pid`.

Task 3: Documentation
  MODIFY packages/logfire-node/README.md:
    - Document which process events Logfire hooks (`beforeExit`, `SIGTERM`, `uncaughtExceptionMonitor`, `unhandledRejection`).
    - State that Logfire does not install `SIGINT` handling in this PRP.
    - State the `SIGTERM` behavior:
      - Logfire re-emits `SIGTERM` with `process.kill(process.pid, 'SIGTERM')` after best-effort shutdown when Logfire is the only SIGTERM listener.
      - If users install their own SIGTERM handler, Logfire performs telemetry shutdown but leaves process termination to app-level lifecycle code.
    - Note the `unhandledRejection` behavior honestly: Logfire observes/reports/flushes, and this PRP does not restore Node's default fatal behavior.
    - Note that `uncaughtExceptionMonitor` can only schedule async telemetry flush before Node continues its default crash path.
    - State that Logfire does not hook `process.on('exit')` because async flush cannot complete from that event.

Task 4: Release metadata
  CREATE .changeset/<descriptive-name>.md:
    - Patch bump `@pydantic/logfire-node`.
    - Lead with intent: "Make Node SDK process handlers safe and bounded under signal/error termination."
```

### Integration Points

```yaml
NODE:
  - process.on('beforeExit', ...)
  - process.on('SIGTERM', ...)
  - process.on('uncaughtExceptionMonitor', ...)
  - process.on('unhandledRejection', ...)
  - shutdownRuntime / flushRuntime / forceFlushBestEffort from PRP 002

DOCS:
  - packages/logfire-node/README.md
```

## Validation

Run focused checks:

```bash
vp run @pydantic/logfire-node#test
vp run @pydantic/logfire-node#typecheck
```

Run broader checks before PR:

```bash
pnpm run build
pnpm run format-check
```

### Required Test Coverage

- [x] `beforeExit` triggers bounded best-effort shutdown once.
- [x] `uncaughtExceptionMonitor` reports the error and schedules flush without throwing.
- [x] `unhandledRejection` reports the error and flushes without throwing.
- [x] `SIGTERM` snapshots listener state before shutdown removes listeners.
- [x] `SIGTERM` flushes/shuts down and then re-emits `SIGTERM` via `process.kill(process.pid, 'SIGTERM')` when Logfire is the only listener.
- [x] `SIGTERM` flushes/shuts down and does not force-exit when a user SIGTERM listener is also installed.
- [x] `SIGTERM` re-emits when the handler runs after Logfire's listener has already been removed by another lifecycle trigger and no user SIGTERM listeners are present.
- [x] `SIGTERM` does not re-emit when Logfire's listener is already absent but user SIGTERM listeners are present.
- [x] Logfire does not install a `SIGINT` listener.
- [x] Repeated handler invocations share one shutdown promise.
- [x] Handler exceptions are swallowed and logged.

## Unknowns & Risks

- Signal-handler behavior is the most user-visible runtime change in the parity sweep. A wrong mechanism choice can produce orphaned processes (in containers, supervisors) or lost stdout buffers (during `process.exit`).
- Signal tests can become brittle. Keep termination behavior behind small helpers that can be tested without ending the process.
- The current `_shutdown` flag in `beforeExit` and the `shutdownPromise` cache in `shutdownRuntime` are redundant; unifying them is the right cleanup but must preserve the existing "only flush once on `beforeExit`" invariant.
- `unhandledRejection` remains a known semantic gap after this PRP: current Logfire behavior suppresses Node's default fatal behavior. That needs a separate explicit product decision because changing it can break users who have come to rely on the current behavior.
- `uncaughtExceptionMonitor` remains best-effort only. Async telemetry flush scheduled from that hook normally will not complete during a true uncaught-exception crash.
- `SIGTERM` correctness depends on snapshot ordering and four-state listener classification. Re-emit only when the entry snapshot contains either only Logfire's listener or no listeners; otherwise user handlers own termination.

**Confidence: 8/10** for one-pass implementation success now that the signal strategy and `SIGINT` scope are resolved. The remaining risk is making the `SIGTERM` listener detection precise without depending on brittle listener-order assumptions.
