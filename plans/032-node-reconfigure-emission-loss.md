---
repo: /Users/petyo/w/pydantic/logfire-js
---

# PRP 032: Deterministic re-configuration for @pydantic/logfire-node (issue #167)

## Goal

Make `configure()` re-runs and `shutdown()` → `configure()` sequences in `@pydantic/logfire-node` deterministic: every emission after a `configure()` call routes to that configuration's providers and exporters, superseded SDK generations are fully torn down (globals unregistered, instrumentations disabled), and lifecycle calls (`shutdown()`, `forceFlush()`) complete promptly when `sendToLogfire` is false.

## Why

- Fixes [pydantic/logfire-js#167](https://github.com/pydantic/logfire-js/issues/167): under HMR-style dev servers (mcp-use with tsx re-imports), all logfire emissions silently stop after the 2nd-3rd `configure()`. Spike 01 proves the failure needs no HMR at all — any second `configure()` in one process is silently ignored.
- Fixes an adjacent defect found during research: `shutdown()`/`forceFlush()` with `sendToLogfire: false` and buffered spans hangs for the 30s deadline (void exporters never invoke the OTel result callback), so every re-configure in a tokenless dev environment burns a hung flush.

## Success Criteria

- [ ] After a second `configure()`, emissions through the public API reach only the new configuration's span processors (CX-1).
- [ ] After `await shutdown()` followed by `configure()`, emissions reach the new configuration (CX-2).
- [ ] `shutdown()` with `sendToLogfire: false` and buffered spans resolves promptly instead of timing out after 30s (CX-3).
- [ ] Consumer-supplied instrumentations from a superseded configuration are disabled when replaced or shut down (CX-4).
- [ ] Existing logfire-node tests keep passing; a changeset records the patch release.

## Assurance

- **Profile**: Standard
- **Rationale**: one package, one public boundary (`@pydantic/logfire-node` exports), reversible, no migration/security surface. The load-bearing empirical unknowns were closed by Spike 01 against the built package. The one semantic risk — `disable()` semantics in mixed-ownership setups — is bounded and recorded under Unknowns & Risks.

## Consumer Contract

### Consumer and Public Boundary

- **Consumer(s)**: Node.js SDK integrators calling `configure()` more than once per process — directly, via dev-server module re-evaluation (issue #167), or after an explicit `shutdown()`.
- **Public or supported boundary**: `@pydantic/logfire-node` exports: `configure()`, `shutdown()`, `forceFlush()`, and the emission API re-exported from `logfire` (`info`, `span`, `startSpan`, ...). `additionalSpanProcessors` and `instrumentations` config options are the observable attachment points.
- **Entry point and prerequisites**: `import * as logfire from '@pydantic/logfire-node'`; no token for the scenarios below.
- **Current observable behavior**: every `configure()` after the first is silently ignored (emissions stay pinned to the first generation, then go silent once it shuts down); same after `shutdown()`; `shutdown()` with buffered spans and no token rejects after a 30s hang (Spike 01, all four experiments).
- **Observable promise**: last `configure()` wins — emissions after it route to its processors only; lifecycle calls settle promptly.
- **Must remain compatible with**: single-`configure()` usage (the dominant path), the existing `configure()`/`shutdown()`/`forceFlush()` signatures (all stay synchronous/identical), and the process-lifecycle hooks (beforeExit/SIGTERM behavior unchanged).
- **Not claimed**: correct interop when the application registered its own OTel globals before or between logfire configures (see Unknowns & Risks); preservation of async context continuity across a re-configure boundary for in-flight requests; unsetting the `diag` logger on teardown — `diag.setLogger` allows override, so a later `configure({ diagLogLevel })` still wins; do not add `diag.disable()` to teardown (it would silence the teardown path's own warnings).

### Acceptance Scenarios

| ID     | Given                                                                                    | When                                                                         | Then                                                          | Exact exercise and prerequisites                                                                                                                                                                                                                                                                         | Required evidence                                                                                                                                       |
| ------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CX-1` | `configure()` ran with span processor A; an emission reached A                           | `configure()` runs again with span processor B, then `logfire.info('probe')` | B receives the probe; A does not receive it                   | New `__test__/reconfigure.integration.test.ts` in logfire-node: real `NodeSDK`/OTel API (no mocks), two sequential `configure({ sendToLogfire: false, metrics: false, additionalSpanProcessors: [...] })` calls with recording processors, assertions on received span names; `logfire` dist built first | DIRECT REQUIRED — exercises the public package entry points in-process, same surface the browser package's `providerLifecycle.integration.test.ts` uses |
| `CX-2` | `configure()` ran and `await shutdown()` resolved                                        | `configure()` runs with span processor B, then `logfire.info('probe')`       | B receives the probe                                          | Same integration test file, separate test case                                                                                                                                                                                                                                                           | DIRECT REQUIRED — same surface                                                                                                                          |
| `CX-3` | `configure({ sendToLogfire: false })` ran and a span was emitted (buffered)              | `await shutdown()`                                                           | Resolves without error well under the 30s deadline            | Same integration test file; assert resolution within the default 5s vitest timeout                                                                                                                                                                                                                       | DIRECT REQUIRED — the current behavior rejects after 30s, so the test fails on baseline                                                                 |
| `CX-4` | `configure({ instrumentations: [fake] })` ran with a consumer-supplied `Instrumentation` | `configure()` runs again (or `shutdown()` is awaited)                        | The superseded fake instrumentation's `disable()` was invoked | Same integration test file, fake object implementing the `Instrumentation` interface passed through the public `configure()` option                                                                                                                                                                      | DIRECT REQUIRED — the instrumentation instance is consumer-supplied, so its `disable()` call is consumer-observable                                     |

## Research Summary

### Vetted Repository Findings

- `packages/logfire-node/src/sdk.ts:263-271` — `start()` tears down the previous runtime fire-and-forget and immediately constructs/starts a new `NodeSDK`; nothing ever unregisters OTel API globals — **PRP impact**: core defect site; teardown must disable owned globals before the new registration.
- `node_modules/.pnpm/@opentelemetry+api@1.9.1/.../internal/global-utils.js` and `.../api/trace.js` — `registerGlobal` refuses duplicates (diag-only error) and `setGlobalTracerProvider` then skips `setDelegate`; `disable()` unregisters and replaces the proxy — **PRP impact**: the global proxy stays delegated to generation 1 forever; `disable()` is the sanctioned reset.
- `node_modules/.pnpm/@opentelemetry+sdk-node@0.219.0.../src/sdk.js` — `start()` registers all five globals; `shutdown()` never unregisters — **PRP impact**: awaiting the previous shutdown alone cannot fix the bug; explicit `disable()` calls are required.
- `packages/logfire-api/src/logfireApiConfig.ts:98,126-129` — `logfireApiConfig.tracer` is a module-load-time `ProxyTracer` (which permanently caches its first real delegate) and is only re-fetched when `otelScope` is passed — **PRP impact**: after re-registration succeeds, the tracer must be re-fetched or emissions stay pinned to the dead generation.
- `packages/logfire-api/src/index.ts:426,455,471,561` — all manual emissions go through `logfireApiConfig.tracer` — **PRP impact**: refreshing that one field covers the whole manual API.
- `packages/logfire-browser/src/index.ts:556` — browser assigns `logfireApiConfig.tracer` on configure — **PRP impact**: precedent that the runtime package owns the tracer refresh; no `logfire-api` change needed.
- `packages/logfire-browser/src/index.ts:423` and `providerLifecycle.ts:164-178` — browser disables superseded instrumentations and uses `trace/context/propagation.disable()` for teardown — **PRP impact**: canonical in-repo pattern for global teardown (PRP 024 lineage).
- `packages/logfire-node/src/VoidTraceExporter.ts:5`, `packages/logfire-node/src/VoidMetricExporter.ts:5` — `export()` never invokes `resultCallback`, violating the `SpanExporter`/`PushMetricExporter` contract — **PRP impact**: `BatchSpanProcessor`/`PeriodicExportingMetricReader` flushes hang until deadline (Spike 01 additional discovery).
- `packages/logfire-node/src/__test__/sdk.test.ts:240-287` — the whole OTel surface is mocked, so global registration was never exercised — **PRP impact**: regression coverage must be a real-SDK integration test; the `vi.mock('logfire')` factory must gain `logfireApiConfig` once `sdk.ts` imports it.
- `node_modules/.pnpm/@opentelemetry+instrumentation@0.219.0.../autoLoader.js` — `registerInstrumentations` returns an unload function that `NodeSDK` discards — **PRP impact**: superseded generations keep patched modules emitting through dead providers unless logfire disables them itself.
- `packages/logfire-api/package.json` — `logfire` resolves to `dist/` in tests — **PRP impact**: `logfire` must be built before running the new integration test; `sdk.ts` and the test share the same `logfireApiConfig` singleton through the dist module.

### Settled Decisions and Rejected Alternatives

- **Decision**: teardown of a logfire-owned runtime disables all five API globals (`trace`, `metrics`, `propagation`, `context` from `@opentelemetry/api`; `logs` from `@opentelemetry/api-logs`), guarded by a module-level "which runtime registered the globals" marker, in the synchronous prefix of `shutdownRuntime()` — **Evidence/rationale**: Spike 01 `fix`/`shutdown-fix` experiments; sync-prefix placement makes the reconfigure path deterministic (globals are free before the new `sdk.start()`), and the marker guard makes a late-settling previous shutdown a no-op against a newer runtime.
- **Decision**: refresh `logfireApiConfig.tracer` after `sdk.start()` inside `start()` — **Evidence/rationale**: browser precedent (`index.ts:556`); after registration succeeds, `trace.getTracer()` returns a real tracer bound to the new provider, avoiding the `ProxyTracer` permanent-cache trap.
- **Decision**: track the instrumentation instances per runtime and `disable()` them in the same teardown prefix — **Evidence/rationale**: browser precedent (`index.ts:423`); prevents superseded patches from wrapping modules twice and parenting real spans under never-exported spans.
- **Decision**: fix both void exporters to call `resultCallback({ code: ExportResultCode.SUCCESS })` — **Evidence/rationale**: OTel exporter contract; required for CX-3 and for the fire-and-forget teardown not to burn 30s per reconfigure.
- **Rejected**: awaiting the previous SDK shutdown before `start()` (the issue reporter's primary hypothesis) — `NodeSDK.shutdown()` never unregisters globals, so ordering alone changes nothing (verified in sdk-node 0.219.0 source); also would force `configure()` to become async, a public signature change.
- **Rejected**: stable delegating provider registered once (browser/Python architecture) — `NodeSDK` performs its own global registration and does not expose its providers, so this requires abandoning `NodeSDK`; larger rearchitecture than the defect warrants. Reopen only if a future PRP drops `NodeSDK`.
- **Rejected**: process-global configure guard (issue workaround) — punishes legitimate re-configuration (config changes between calls would be silently ignored).

### Spike Evidence

- `plans/research/032-node-reconfigure-emission-loss/spike-01-sequential-reconfigure-repro.md` — **Question**: does a plain sequential re-configure reproduce #167 and does disable+refresh fix it? — **Result/decision**: CONCLUSIVE; all emissions stay pinned to generation 1 on both the reconfigure and shutdown→reconfigure paths; disabling the five globals plus tracer refresh restores exact per-generation routing — **Limits**: pass-through spike processors don't gate on shutdown, so terminal silence was shown structurally (new generation receives nothing) rather than literally; mixed-ownership setups untested.

### Validation Baseline

| Command                                   | Status                 | Observed or expected result                  |
| ----------------------------------------- | ---------------------- | -------------------------------------------- |
| `vp run @pydantic/logfire-node#test`      | Verified               | 7 files, 80 tests passed (496ms)             |
| `vp run @pydantic/logfire-node#typecheck` | Verified               | tsc clean                                    |
| `pnpm run build`                          | Verified               | all packages build                           |
| `pnpm run check`                          | Discovered but not run | full-workspace gate; run as final validation |

### Research Coverage

- **Depth**: Standard (plus one scratch spike)
- **Inspected**: logfire-node `sdk.ts`/`logfireConfig.ts`/`index.ts`/void exporters/tests; logfire-api config + emission path; browser `providerLifecycle` analogue; installed `@opentelemetry` `api` 1.9.1, `api-logs` 0.219.0, `sdk-node` 0.219.0, `instrumentation` 0.219.0 sources; issue #167 report.
- **Not inspected**: `logfire-cf-workers`/`otel-cf-workers` (per-request lifecycle, no `configure()` re-run surface), managed-variables internals (`configureVariables` already replaces state per `start()` and previous teardown passes `shutdownVariables: false` — unchanged), OTLP exporter internals.
- **Research confidence**: HIGH — mechanism confirmed in installed library source and reproduced/validated empirically against the built package.

## Execution Contract

- **Planned at commit**: `a22a826`
- **Planning baseline**: clean except untracked `plans/research/032-node-reconfigure-emission-loss/` (this PRP's research artifacts; preserve)

### Expected Changes

- `packages/logfire-node/src/sdk.ts` — global-disable teardown, registrant tracking, instrumentation tracking/disable, tracer refresh
- `packages/logfire-node/src/VoidTraceExporter.ts` — invoke result callback
- `packages/logfire-node/src/VoidMetricExporter.ts` — invoke result callback
- `packages/logfire-node/src/__test__/reconfigure.integration.test.ts` — new; CX-1..CX-4
- `packages/logfire-node/src/__test__/sdk.test.ts` — extend `vi.mock('logfire')` with `logfireApiConfig`; unit assertions for disable-on-teardown
- `.changeset/*.md` — patch for `@pydantic/logfire-node`

### Explicitly Out of Scope

- Any `logfire` (logfire-api) source change — the tracer refresh lives in logfire-node (browser precedent).
- Browser and Cloudflare Workers packages.
- Making `configure()` async or awaiting the previous flush before returning (public signature unchanged; the fire-and-forget flush of the previous generation remains).
- De-duplicating auto-instrumentation _within_ a single configure, or interop with app-owned OTel globals (documented limitation).

### Scope Expansion Rule

Additional files may be changed when necessary to satisfy the PRP without changing its intent or architecture. Record each added file and rationale in Execution Notes. Pause for user direction if expansion materially changes product behavior, architecture, a public API/schema, security posture, migration risk, or agreed scope.

### Pause and Reassess If

- The disable-then-restart sequence breaks any existing single-configure test (would indicate the ownership marker is wrong).
- CX-1 requires touching `logfire-api` after all (singleton identity between src and dist diverges in vitest).
- Fixing the void exporters surfaces a dependency on the hang (e.g. a test that relied on flush never completing).
- Auto-instrumentation `disable()` throws for a bundled instrumentation in the integration environment (would need a per-instrumentation try/catch strategy decision beyond diag-warn).

## Context

### Key Files

- `packages/logfire-node/src/sdk.ts` — all changes centre here: `start()`, `shutdownRuntime()`, `ActiveRuntime`
- `packages/logfire-browser/src/providerLifecycle.ts:164-178` — teardown pattern to mirror (`safelyDisable` wrappers)
- `packages/logfire-browser/src/index.ts:423,556` — instrumentation-disable and tracer-refresh precedents
- `packages/logfire-node/src/__test__/sdk.test.ts` — mock structure to extend, not bypass
- `packages/logfire-browser/src/providerLifecycle.integration.test.ts` — precedent for a real-OTel integration test colocated with mocked unit tests

### Gotchas

- `logfire` resolves to `dist/` in logfire-node tests — build `logfire` (e.g. `pnpm run build` or `vp run logfire#build`) before running the new integration test, or the test exercises stale code.
- `sdk.ts` gaining `import { logfireApiConfig } from 'logfire'` breaks `sdk.test.ts`'s `vi.mock('logfire')` factory unless `logfireApiConfig` is added to it (a plain `{ otelScope: 'logfire', tracer: <sentinel> }` object suffices for unit assertions).
- The disable calls must run in the _synchronous_ prefix of `shutdownRuntime()` (before the first `await`, next to `removeProcessListeners`) — the reconfigure path invokes it fire-and-forget and relies on the globals being free before the new `sdk.start()` executes.
- `trace.disable()` replaces the API's proxy provider; a tracer fetched _before_ `sdk.start()` re-registers would bind to a dead proxy — refresh `logfireApiConfig.tracer` strictly _after_ `sdk.start()`.
- Vitest runs each test file in its own isolated environment, so the integration test's real global registrations cannot leak into the mocked unit-test files.
- In the integration test, use `metrics: false` — the default metric reader adds a real `PeriodicExportingMetricReader` that slows shutdown assertions without adding coverage (the void-metric-exporter fix gets its own unit assertion instead).

## Implementation Blueprint

### Tasks

```yaml
Task 1: Fix void exporters to honor the OTel exporter contract
  MODIFY packages/logfire-node/src/VoidTraceExporter.ts:
    - export(spans, resultCallback) invokes resultCallback({ code: ExportResultCode.SUCCESS })
  MODIFY packages/logfire-node/src/VoidMetricExporter.ts:
    - same for PushMetricExporter.export(metrics, resultCallback)
  CREATE packages/logfire-node/src/__test__/voidExporters.test.ts:
    - both exporters invoke the result callback with ExportResultCode.SUCCESS
      (covers the metric path, which the CX-3 integration test does not exercise)
  PATTERN: ExportResultCode usage in packages/logfire-node/src/LogfireConsoleSpanExporter.ts;
    test shape from __test__/LogfireConsoleSpanExporter.test.ts
  ENABLES: CX-3 (and un-hangs teardown for every other scenario)
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-node#test
    - EXPECTED: existing 80 tests still pass plus the new void-exporter assertions

Task 2: Disable logfire-owned globals and superseded instrumentations on teardown
  MODIFY packages/logfire-node/src/sdk.ts:
    - ActiveRuntime gains `instrumentations: Instrumentation[]`; populate with the
      array passed to NodeSDK (auto + user) in start()
    - module-level `let globalsRegistrant: ActiveRuntime | undefined`; set to the
      new runtime immediately BEFORE sdk.start() — if start() throws mid-registration,
      the next teardown still disables the partially registered globals
    - helper that, when `globalsRegistrant === runtime`, clears the marker and calls
      trace/metrics/propagation/context.disable() (from @opentelemetry/api) and
      logs.disable() (from @opentelemetry/api-logs), each wrapped like the browser's
      safelyDisable; also disable each runtime.instrumentations entry (diag.warn on throw)
    - invoke the helper in the synchronous prefix of shutdownRuntime(), next to
      removeProcessListeners()
  PATTERN: packages/logfire-browser/src/providerLifecycle.ts:164-178 (safelyDisable), index.ts:423
  ENABLES: CX-1, CX-2, CX-4
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-node#test
    - EXPECTED: existing tests pass (mocked NodeSDK never registers globals, so the disables are no-ops there)

Task 3: Refresh the shared API tracer after the new SDK registers
  MODIFY packages/logfire-node/src/sdk.ts:
    - after sdk.start():
      logfireApiConfig.tracer = trace.getTracer(logfireApiConfig.otelScope)
  MODIFY packages/logfire-node/src/__test__/sdk.test.ts:
    - add `logfireApiConfig` to the vi.mock('logfire') factory
    - unit assertions: reconfigure and shutdown() trigger the disable path; tracer is reassigned after start()
  PATTERN: packages/logfire-browser/src/index.ts:556
  ENABLES: CX-1, CX-2
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-node#test
    - EXPECTED: all unit tests pass including new assertions

Task 4: Integration regression tests through the public boundary
  CREATE packages/logfire-node/src/__test__/reconfigure.integration.test.ts:
    - no vi.mock of OTel/logfire modules; recording span processors via
      additionalSpanProcessors; configure/info/shutdown from the package entry points
    - CX-1: two configures; probe after the second lands only in processor B
    - CX-2: configure → await shutdown() → configure; probe lands in processor B
    - CX-3: configure({ sendToLogfire: false }) → info() → await shutdown() resolves
      (fails on baseline with a 30s timeout rejection)
    - CX-4: fake Instrumentation via configure({ instrumentations: [fake] });
      reconfigure and shutdown each mark it disabled
    - restore a clean state per test (await shutdown() in afterEach)
  PATTERN: packages/logfire-browser/src/providerLifecycle.integration.test.ts
  ENABLES: CX-1, CX-2, CX-3, CX-4
  VERIFY:
    - COMMAND: pnpm run build && vp run @pydantic/logfire-node#test
    - EXPECTED: all files pass; integration file adds 4+ tests
    - FAILURE-LOCAL: vp run @pydantic/logfire-node#test -- -t "reconfigure" (skips rebuild when dist is current)

Task 5: Changeset and final gate
  CREATE .changeset/<generated>.md:
    - patch @pydantic/logfire-node — "configure() re-runs and shutdown()+configure()
      now deterministically replace the active SDK; shutdown no longer hangs without a token"
  SUPPORTS: release packaging and workspace-wide regression gate (no consumer scenario)
  VERIFY:
    - COMMAND: pnpm run check
    - EXPECTED: build, typecheck, lint, format, and all package tests pass workspace-wide
    - FAILURE-LOCAL: vp run @pydantic/logfire-node#typecheck / #test, pnpm run format-check
```

### Integration Points

None beyond `sdk.ts` — no config files, routes, or schema surfaces change.

## Validation

```bash
pnpm run build                            # logfire dist is a test prerequisite
vp run @pydantic/logfire-node#test        # focused package tests incl. integration file
vp run @pydantic/logfire-node#typecheck
pnpm run check                            # full workspace gate
```

The `CX-N` table is the authoritative consumer verification plan; the integration test file is its executable form. Optionally, rerunning Spike 01's `repro` script against the fixed build (per-generation routing without manual disable/refresh) supplies published-dist-level supplementary evidence.

## Unknowns & Risks

- **Mixed OTel ownership**: if the application registered its own global tracer provider before logfire's first `configure()`, logfire's registration already fails silently today; with this change, a _re_-configure will disable the app's globals and take them over (last-configure-wins). The registrant marker tracks which logfire runtime _attempted_ registration, not whether it won — `registerGlobal` refuses duplicates by returning false without throwing, so `NodeSDK.start()` cannot signal refusal — which means `shutdown()` in such a process also clears the host's globals (re-raised by CodeRabbit on PR #168; unchanged for the same reason). Bounded: such setups are already broken today (logfire emissions never worked there), and the marker still protects logfire-generation ordering (a late-settling old teardown cannot clear a newer runtime's globals). User-accepted 2026-07-15 (see Clarifications): implement last-configure-wins without external-owner detection.
- **Async context continuity**: `context.disable()` during re-configure detaches in-flight async chains from the old ALS manager; spans started before and ended after a re-configure may lose parenting. Inherent to swapping context managers; only affects the re-configure window.
- **Auto-instrumentation disable cost**: disabling ~30 auto-instrumentations per teardown is new work on the shutdown path; each is a cheap unpatch, and the browser package has shipped the same pattern.

**Confidence: 9/10** for one-pass implementation success — the fix was executed end-to-end (manually) against the built package in Spike 01; the main residual risk is unit-test mock plumbing.

## Clarifications

- Q: Mixed-ownership policy when re-configure takes over app-registered OTel globals? -> A: Last-configure-wins, unconditionally; no external-owner detection or warning path.
- Q: Keep the void-exporter hang fix in this PRP or split into its own PR? -> A: Keep in this PRP; one PR, one patch changeset covering both defects.
- Q: GitHub follow-up on issue #167? -> A: After verification, post a comment directly via `gh` (once the fix is merged-ready) summarizing the confirmed root cause — global re-registration refusal plus cached `ProxyTracer`, not the unawaited-shutdown race — and the fix. Delivery step, not a code task.

## Execution Notes

### Scope Expansions

- `packages/logfire-node/src/__test__/voidExporters.test.ts` — named in Task 1 but omitted from the Expected Changes forecast; unit coverage for the metric-exporter callback path that the integration tests do not exercise.

### Deviations

- None from the blueprint. One evidence nuance for verification: in a falsification run against the pre-fix source (fix hunks stashed, tests kept), CX-1, CX-2, CX-4, both void-exporter tests, and all three new unit tests fail, but CX-3 passes — the stuck-globals defect masks the flush hang when the file's earlier tests have already pinned emissions to a dead generation, so nothing reaches CX-3's buffer. CX-3's pre-fix failure standalone is evidenced by Spike 01's `shutdown-reconfigure` run (30s `AggregateError: logfire SDK: shutdown failed`).

### Post-review fixes

- PR #168 review (confirmed against installed OTel 0.219.0 source and a failing repro test): a consumer instrumentation instance reused across `configure()` calls ended up permanently disabled — teardown's `disable()` flips only the instrumentation's private enabled flag, while `registerInstrumentations` skips `enable()` whenever `getConfig().enabled` is true, assuming instances arrive enabled from their constructor. Fixed two ways in `sdk.ts`: teardown retains instances shared with the replacement configuration (no unpatch/repatch churn in the common stable-config case), and `start()` re-enables user instrumentations after `sdk.start()` (covers reuse after a generation gap and a `shutdown()` racing a re-configure, where the memoized shutdown promise ignores the retain set). Regression coverage: reused-instance and generation-gap integration tests plus a retain unit test.
