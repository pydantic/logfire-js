## Goal

Refine Node process signal and error handlers so they use bounded best-effort lifecycle helpers, never throw, and preserve expected process termination behavior.

This PRP depends on:

- PRP 002: complete Node lifecycle flush/shutdown (provides the bounded best-effort helpers and `shutdownPromise` reentrancy guard this PRP builds on).

This PRP is intentionally scoped to:

- `beforeExit`, `uncaughtExceptionMonitor`, `unhandledRejection`, `SIGTERM`, and `SIGINT` handler refinement in Node
- Tests that exercise handler behavior without terminating the test runner

Out of scope:

- Browser and Cloudflare runtime parity, covered by PRP 005
- Tail sampling, pending spans, or exporter behavior

## Why

- Node signal handlers change default process behavior. Once the SDK installs a `SIGTERM` listener, Node no longer terminates by default on that signal — the handler must ensure termination after best-effort flush.
- Process handlers run during sensitive states (shutdown, crash). An exception inside a handler can mask the original cause of termination or prevent flush.
- The current handlers were added in PRP 002 with the lifecycle helpers in mind, but did not finalize the signal-termination semantics or the fatal-handler best-effort path.
- This is the only piece in the runtime-parity sweep that can introduce production regressions (orphaned processes, supervisor restart loops, lost stdout buffers). It deserves a focused review pass.

## Success Criteria

- [ ] `beforeExit` uses a bounded best-effort shutdown that never throws.
- [ ] `uncaughtExceptionMonitor` reports the error (existing behavior) and then triggers a bounded best-effort flush of all tracked telemetry paths (spans, logs, metrics) without throwing.
- [ ] `unhandledRejection` reports the error (existing behavior) and then triggers a bounded best-effort flush without throwing.
- [ ] `SIGTERM` and `SIGINT` perform bounded best-effort flush/shutdown, then preserve the signal's default termination behavior so the process actually exits.
- [ ] No handler throws under any code path; failures are logged via `diag.warn`/`diag.error` and swallowed.
- [ ] Tests cover the signal/error-handler behavior without actually terminating the test runner.
- [ ] Existing PRP 002 reentrancy guarantee (one shutdown promise per runtime) still holds when handlers fire concurrently or repeatedly.

## Clarifications

### Open questions to resolve before execution

These should be answered via `AskUserQuestion` before Task 1 begins; they affect the implementation in non-trivial ways.

- Q: How should `SIGTERM`/`SIGINT` preserve termination after best-effort flush? Options:
  1. Remove the listener and re-emit the signal (`process.kill(process.pid, signo)`), letting Node apply its default behavior.
  2. Explicitly call `process.exit(128 + signo)` once flush settles or the deadline expires.
  3. Detach the listener and let the next signal terminate normally (less reliable; second signal may never come).
- Q: Should `uncaughtExceptionMonitor` and `unhandledRejection` flush _all_ tracked telemetry paths (spans + logs + metrics) or only spans? PRP 002 implemented best-effort flush against `runtime.spanProcessors` plus log/metric readers — confirm parity.
- Q: Should `SIGINT` be handled at all? Some libraries deliberately leave `SIGINT` alone so users can Ctrl-C in development. State the answer explicitly so the test suite can lock it in.

## Context

### Key Files

- `packages/logfire-node/src/sdk.ts` - Node process handlers and best-effort lifecycle helpers from PRP 002 (see `forceFlushBestEffort`, `flushRuntime`, `shutdownRuntime`).
- `packages/logfire-node/src/__test__/sdk.test.ts` - Node process listener tests.
- `packages/logfire-node/README.md` - documentation of process handler behavior.

### Python Reference

- `../logfire/logfire/_internal/config.py` - AWS Lambda flush hook and process-exit flushing patterns. Python does not install signal handlers by default; this is a JS-specific concern driven by Node's signal semantics.

### Gotchas

- Once the SDK installs a `SIGTERM` listener, Node no longer terminates by default. The handler MUST ensure termination, either by re-emitting the signal with the listener removed or by calling `process.exit(...)`.
- Calling `process.exit()` from inside an async handler can drop stdout/stderr buffers and unflushed file descriptors. Prefer re-emitting the signal when possible, or only call `process.exit` after the flush promise has settled and a small drain tick has run.
- `uncaughtExceptionMonitor` is the right hook for "observe, don't prevent crash" — it does NOT suppress the default crash behavior. If anyone changes it to `uncaughtException`, the process semantics flip silently (the process no longer crashes). Add a comment guarding this if necessary.
- Handlers can re-enter: a `SIGTERM` arriving during a `beforeExit`-triggered shutdown should not start a second shutdown. The existing `shutdownPromise` cache in `shutdownRuntime` handles this; signal handlers must call through that path rather than reaching past it.
- Tests must stub `process.exit`, `process.kill`, or the handler internals to avoid terminating the test runner. Do NOT emit real signals via `process.kill(process.pid, ...)` in tests.
- The current `beforeExit` handler uses an `_shutdown` flag (`sdk.ts:297`) that lives outside the `shutdownPromise` mechanism. Unify these so reentrancy guarantees are not split across two state machines.

## Implementation Blueprint

### Tasks

```yaml
Task 1: Resolve open clarifications
  USE AskUserQuestion to answer the three open questions in the Clarifications section above.
  RECORD answers in a new `### Session YYYY-MM-DD` block under Clarifications before Task 2 begins.

Task 2: Refine handlers in sdk.ts
  MODIFY packages/logfire-node/src/sdk.ts:
    - `beforeExit`: route through the same bounded best-effort path used by other handlers; unify the `_shutdown` flag with the `shutdownPromise` cache so there is one reentrancy guard.
    - `uncaughtExceptionMonitor`: keep the existing error-report call, then trigger bounded best-effort flush of the same telemetry paths confirmed in clarification.
    - `unhandledRejection`: keep the existing error-report call, then trigger bounded best-effort flush.
    - `SIGTERM` and `SIGINT` (per clarification): bounded best-effort flush/shutdown, then preserve signal termination via the chosen mechanism.
    - Wrap every handler body in a try/catch that routes failures through `diag.warn`/`diag.error` and never rethrows.
    - Factor small internal helpers (`bestEffortLifecycle(runtime, reason)`, `terminateAfterFlush(signal, runtime)`) so tests can call them directly.

Task 3: Tests
  MODIFY packages/logfire-node/src/__test__/sdk.test.ts:
    - Assert each handler calls the bounded best-effort lifecycle helper exactly once even when invoked repeatedly.
    - Assert handler failures are swallowed and surfaced via diag.
    - Assert `SIGTERM`/`SIGINT` termination preservation by stubbing the chosen mechanism (e.g. spy on `process.kill` or `process.exit`) and verifying it is invoked after flush settles.
    - Assert reentrancy: concurrent invocations share the same shutdown promise.
    - Do NOT emit real signals against `process.pid`.

Task 4: Documentation
  MODIFY packages/logfire-node/README.md:
    - Document which process events Logfire hooks (`beforeExit`, `SIGTERM`, `SIGINT`, `uncaughtExceptionMonitor`, `unhandledRejection`).
    - State the termination-preservation behavior chosen in clarification.
    - Note that users who install their own SIGTERM handler should be aware Logfire also installs one, and explain the interaction.

Task 5: Release metadata
  CREATE .changeset/<descriptive-name>.md:
    - Patch bump `@pydantic/logfire-node`.
    - Lead with intent: "Make Node SDK process handlers safe and bounded under signal/error termination."
```

### Integration Points

```yaml
NODE:
  - process.on('beforeExit', ...)
  - process.on('SIGTERM', ...)
  - process.on('SIGINT', ...)
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

- [ ] `beforeExit` triggers bounded best-effort shutdown once.
- [ ] `uncaughtExceptionMonitor` reports the error and flushes without throwing.
- [ ] `unhandledRejection` reports the error and flushes without throwing.
- [ ] `SIGTERM` flushes and then triggers the chosen termination-preservation mechanism.
- [ ] `SIGINT` behavior matches the clarification decision (handled or intentionally not handled).
- [ ] Repeated handler invocations share one shutdown promise.
- [ ] Handler exceptions are swallowed and logged.

## Unknowns & Risks

- Signal-handler behavior is the most user-visible runtime change in the parity sweep. A wrong mechanism choice can produce orphaned processes (in containers, supervisors) or lost stdout buffers (during `process.exit`).
- Signal tests can become brittle. Keep termination behavior behind small helpers that can be tested without ending the process.
- The current `_shutdown` flag in `beforeExit` and the `shutdownPromise` cache in `shutdownRuntime` are redundant; unifying them is the right cleanup but must preserve the existing "only flush once on `beforeExit`" invariant.

**Confidence: 7/10** for one-pass implementation success, conditional on the three open clarifications being resolved before Task 2.
