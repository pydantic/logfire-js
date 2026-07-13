# Make Browser Provider Reconfiguration Ownership-Safe

## Goal

Support deterministic same-page `@pydantic/logfire-browser` reconfiguration through one page-stable, non-caching delegating tracer provider. After cleanup of configuration A and configuration of B, cached application-global tracers, Logfire manual APIs, and explicitly registered browser instrumentations must route new spans to B without unregistering application-owned OpenTelemetry trace, context, or propagation globals.

## Why

- The current browser SDK creates and registers a concrete `WebTracerProvider` for every `configure()` call. OpenTelemetry accepts only the first global provider, so cleanup A followed by configure B silently leaves manual/global spans routed to the shut-down A provider while explicit-provider instrumentation spans reach B.
- `trace.disable()`, `context.disable()`, and `propagation.disable()` remove whichever globals are current; they cannot prove Logfire ownership and can break an application that registered OpenTelemetry first.
- The browser package's provider mock calls `trace.disable()` during shutdown even though the real `WebTracerProvider.shutdown()` does not. Existing tests therefore hide the production split.
- Same-page reconfiguration is useful in tests, preview shells, authentication/tenant changes, and applications that replace their complete telemetry setup. It must have a stable contract before the alpha packages become official releases.

## Success Criteria

- [x] One page-stable delegating provider returns tracers that select the current concrete generation provider on every `startSpan()` and `startActiveSpan()` call; retained tracers switch from A to B and are non-recording between generations.
- [x] One deduplicated browser runtime permits only one active or cleaning generation. `configure()` rejects overlap deterministically and accepts a new generation only after prior cleanup fulfills; rejected cleanup enters a terminal failed state requiring page reload.
- [x] Logfire manual helpers and configured instrumentations use the same generation provider even when an application already owns the OpenTelemetry global tracer provider.
- [x] Runtime cleanup preserves its current best-effort/idempotent ordering, deactivates only its own generation before trace flush/shutdown, and never calls global trace/context/propagation disable APIs; only same-stack rollback of a just-registered, failed-to-enable Logfire context manager may call `context.disable()`.
- [x] A Logfire-owned context manager and default propagator remain page-stable across generations. Incompatible later explicit context-manager requests fail without enabling, disabling, or replacing the proposed/application manager.
- [x] Spans already started under A remain A-owned and are export-guaranteed only when ended before A cleanup; they are never migrated to B.
- [x] Trace, context, and propagation ownership are handled independently across every mixed-ownership combination; external owners survive cleanup and stale cleanup cannot detach a newer generation.
- [x] Focused real-OpenTelemetry tests, a direct real-browser Zone-context/receipt fixture, typecheck, build, and repository release checks pass.

## Roadmap Context

- **Parent roadmap**: `plans/roadmaps/001-browser-rum-release-remediation.md`
- **Roadmap step**: `R2` — Establish an ownership-safe browser provider lifecycle.
- **Satisfied dependencies**: the user selected stable same-page delegation; Spikes 01 and 04 are conclusive.
- **Inherited decisions and invariants**: preserve application-owned globals, public `configure()`/async cleanup shape, cleanup error aggregation and promise identity, explicit-provider instrumentation, browser session enrichment, resource/sampling configuration, and optional-feature shutdown order.
- **Contract produced for later steps**: stable cleanup/reconfiguration semantics consumed by R6 public lifecycle documentation and R9 package/browser integration.

## Consumer Contract

### Consumer and Public Boundary

- **Consumer(s)**: browser applications and tests that reconfigure Logfire in one page; applications with partial or complete OpenTelemetry global setup; custom and automatic browser instrumentations; R6/R9 release verification.
- **Public or supported boundary**: `configure(options) -> async cleanup`, manual Logfire span/log helpers re-exported by the browser package, `instrumentations`/`autoInstrumentations`, `contextManager`, application `trace.getTracer(...)`, emitted resources/spans, and global ownership after cleanup.
- **Entry point and prerequisites**: configuration A is created; its cleanup is called and awaited; configuration B is then created. A consumer that owns an OpenTelemetry context manager must register it before Logfire and omit `contextManager` so Logfire uses that manager; trace and propagation may be independently external or absent.
- **Observable promise**: new spans started while A/B is active use that generation's provider/resource/sampler; new spans between generations are non-recording; cleanup never removes another owner's globals.
- **Overlap rule**: calling `configure()` while a generation is active or its cleanup promise remains unsettled throws `logfire-browser: a configuration is already active; await its cleanup before configuring again` before mutating API settings, session state, or exporters. After rejected cleanup, it throws `logfire-browser: the previous cleanup failed; reload the page before configuring again` because the SDK cannot prove all old producers were removed.
- **Context rule**: the first Logfire-owned manager is page-lifetime. Later configurations may omit `contextManager` or pass the identical instance. A different instance is rejected. When context is externally owned, an explicit manager whose registration cannot succeed is left untouched and configuration rejects; omitting it uses the external manager.
- **Context initialization failure**: when Logfire successfully registers a candidate but `enable()` throws, it immediately attempts ownership-proven `context.disable()` rollback. If rollback succeeds, configuration throws the original enable error and a later retry is allowed. If rollback also throws, lifecycle becomes terminal and later configuration throws `logfire-browser: context manager initialization failed and could not be rolled back; reload the page before configuring again`.
- **Span cutoff**: a span's concrete provider is chosen when the span starts. Consumers must end A spans before calling cleanup A to guarantee export. Existing A spans are not transferred to B, while a new span started by a later callback after B activation uses B and follows the still-active global context's ordinary parent semantics.
- **Duplicate bundles**: same-page reconfiguration requires one deduplicated `@pydantic/logfire-browser` and `logfire` runtime. Multiple physical browser copies are unsupported because they may share the single mutable `logfireApiConfig.tracer` while retaining separate lifecycle state. This child still avoids destructive global teardown, but does not promise per-copy manual routing or cross-copy reconfiguration.
- **Must remain compatible with**: OpenTelemetry API 1.9.1, SDK trace web 2.8.0, instrumentation 0.219.0, existing cleanup error aggregation, factory/preconstructed instrumentations, optional async startup, current public option shapes, and R1's verified canonical endpoint patterns, immutable instrumentation-ignore merging, replay URL validation, installed-wrapper tests, and self-observation fixtures.
- **Not claimed**: concurrent configurations; migration/export of spans that outlive their provider shutdown; changing context managers between generations; recovery from arbitrary external `trace.disable()` after Logfire startup; any reconfiguration/manual-routing guarantee across duplicate browser/core package copies; metrics-global ownership changes.

### Acceptance Scenarios

| ID     | Given                                                                                                                      | When                                                                                                                      | Then                                                                                                                                                                                                                   | Evidence surface                                                                          | Required evidence                                                                        |
| ------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `CX-1` | A cached tracer exists before configuration A; Logfire manual helpers and explicit instrumentations emit under A           | A spans end, cleanup A settles, B uses a different resource/sampler/export endpoint, and the same emitters run again      | A receives only A spans/resource, B receives only B spans/resource, all three emitter forms switch to B, and calls made between generations are non-recording                                                          | Built public package, real browser, Zone context manager, decoded local OTLP receipts     | DIRECT REQUIRED                                                                          |
| `CX-2` | Configuration A is active, then cleaning; fulfilled and rejected cleanup paths are controlled                              | Configure is attempted before cleanup, during cleanup, after fulfilled cleanup, and after rejected cleanup                | Active/cleaning calls throw the exact overlap error without side effects; fulfilled cleanup permits B; rejected cleanup deactivates A, attempts every later step, and leaves a terminal exact reload-required error    | Public `configure()` tests with real providers plus controlled cleanup processors         | DIRECT REQUIRED                                                                          |
| `CX-3` | Each mixed subset of trace, context, and propagation globals is application-owned before Logfire                           | Public `configure()` runs without an explicit manager when context is external, emits spans/propagation, and cleans up    | Every external owner survives; Logfire registers only missing globals; manual/instrumentation spans use Logfire while an external trace provider continues serving application-global spans                            | Public-configure real-API eight-case matrix plus all-external browser page/receipts       | DIRECT REQUIRED                                                                          |
| `CX-4` | Logfire owns a Zone context manager in A; separate candidates exercise identity, registration conflict, and enable failure | Async work runs in A/B; a later config proposes another manager; enable-throw rollback succeeds and then separately fails | Zone context works in A/B; different/external candidates remain untouched; successful ownership-proven rollback permits retry, while rollback failure yields the exact terminal reload-required state                  | Real-browser Zone fixture for continuity; real-API unit tests for identity/rollback calls | DIRECT REQUIRED for Zone continuity; PROXY ACCEPTABLE for exact conflict-call accounting |
| `CX-5` | A span starts under A and remains unfinished at the cleanup boundary; cached tracers survive across generations            | Cleanup A and B configuration occur                                                                                       | The existing span remains A-owned and is not migrated; the contract documents that post-shutdown end is not export-guaranteed; new cached-tracer spans route to B; stale/token-mismatched deactivation cannot detach B | Real SDK provider test with recording processors and explicit generation tokens           | DIRECT REQUIRED                                                                          |

## Research Summary

### Vetted Repository Findings

- `packages/logfire-browser/src/index.ts:477-492` — every configuration constructs a concrete `WebTracerProvider` and calls `register()`. — **PRP impact**: construct concrete providers per generation but replace `register()` with page-lifecycle activation.
- `packages/logfire-browser/src/index.ts:539-601` — cleanup unregisters instrumentations and shuts down the provider but never resets the OpenTelemetry global. — **PRP impact**: add generation deactivation without global teardown and preserve the existing drain/error order.
- `packages/logfire-api/src/logfireApiConfig.ts:76-99,126-129` — manual helpers read a mutable cached tracer; it refreshes only when `otelScope` is explicitly changed. — **PRP impact**: bind this existing tracer slot once to a page-stable delegating tracer without adding a public browser option.
- `packages/logfire-browser/src/index.test.ts:34-78` — the mock provider's `shutdown()` calls `trace.disable()`, unlike production. — **PRP impact**: remove the masking behavior and add real-API lifecycle tests.
- `packages/logfire-browser/src/index.test.ts:1265-1335` — cleanup promise identity and error memoization are already tested. — **PRP impact**: retain these tests and extend them with runtime-state release after both fulfillment and rejection.
- `packages/logfire-browser/src/index.ts:322-374` — instrumentation registration receives an explicit concrete tracer provider. — **PRP impact**: keep generation providers explicit; global ownership is not required for browser instrumentation.
- `packages/logfire-browser/src/browserMetrics.ts:220-267` — browser metrics owns a private meter provider and does not set a global. — **PRP impact**: metrics cleanup remains unchanged and outside the delegating trace lifecycle.
- `packages/logfire-browser/README.md:342-365` and `docs/packages/browser.md:419-455` — cleanup is documented but sequential reconfiguration, overlap rejection, global ownership, and the span cutoff are not. — **PRP impact**: update both lifecycle sections and examples.

### Installed OpenTelemetry Constraints

- `@opentelemetry/api` 1.9.1 `TraceAPI.setGlobalTracerProvider()` installs one global proxy and returns `false` on duplicate registration. Its built-in `ProxyTracerProvider`/`ProxyTracer` cache delegates and cannot implement repeated A -> B switching.
- `ContextAPI.setGlobalContextManager()` and `PropagationAPI.setGlobalPropagator()` return registration success, but their `disable()` methods remove the current global without identity checks.
- `WebTracerProvider.register()` discards registration results, registers the concrete provider, installs a default W3C trace/baggage propagator, and enables a context manager as part of per-provider registration.
- `registerInstrumentations()` sets the explicitly supplied tracer provider on every instrumentation before enabling it.
- The public API exposes `trace.wrapSpanContext(INVALID_SPAN_CONTEXT)`, `context.with`, and tracer/provider interfaces. The implementation can provide non-recording inactive spans without importing deprecated/deep OpenTelemetry internals.

### Spike Evidence

- `plans/research/roadmaps/001-browser-rum-release-remediation/spike-01-otel-reconfiguration.md` — current A -> cleanup -> B splits manual/global spans to A and explicit spans to B; blind global disable clobbers application ownership; custom non-caching delegation is feasible.
- `plans/research/roadmaps/001-browser-rum-release-remediation/spike-04-delegating-provider-contract.md` — cached-before-registration and direct tracers switched A -> B and became non-recording while inactive; application-owned global registration remained intact; the duplicate-runtime probe also exposed that package copies sharing one mutable core config cannot promise manual-helper isolation.

### Settled Decisions and Rejected Alternatives

- **Decision**: create a page-lifetime non-caching delegating provider in the supported deduplicated browser runtime; every tracer method resolves the active concrete provider at call time. — **Reason**: built-in OpenTelemetry proxies cache a concrete delegate and reproduce the bug.
- **Decision**: one active/cleaning generation per instance. A cleanup promise must settle before B. — **Reason**: overlap makes resource/session/optional-runtime ownership ambiguous and allows stale cleanup to detach B.
- **Decision**: a generation token controls activation/deactivation even though overlap is rejected. — **Reason**: identity makes cleanup robust against later refactors and ensures an old handle cannot detach another provider.
- **Decision**: bind `logfireApiConfig.tracer` to the stable provider's tracer for the current Logfire scope. — **Reason**: this preserves manual span alignment when an application owns the global without expanding public configuration types.
- **Decision**: track trace, context, and propagation ownership independently as `uninitialized | logfire | external`; register only missing globals and never unregister them during normal cleanup. — **Reason**: OpenTelemetry stores each global separately, so an application may own any subset.
- **Decision**: call `setGlobalContextManager(candidate)` before `candidate.enable()`. On failed registration, leave a caller candidate untouched and reject if it was explicit. If registration succeeds but enable throws, immediately attempt `context.disable()` as a same-stack, ownership-proven initialization rollback. Successful rollback returns context ownership to uninitialized; rollback failure marks lifecycle infrastructure terminal until reload. — **Reason**: enabling first risks touching an external manager, while never rolling back leaves a proven-broken Logfire global installed.
- **Decision**: initialize/validate context ownership before attempting Logfire trace or propagation registration and before activating a generation. — **Reason**: context enable is the only initialization step that invokes caller-controlled code and may throw; handling it first minimizes partial page-global installation.
- **Decision**: successful cleanup returns the instance to idle; rejected cleanup records a terminal failed state after all cleanup steps and generation deactivation were attempted. — **Reason**: an unregister/shutdown error means old producers may still be live, so allowing B could violate the one-generation guarantee.
- **Rejected**: `trace.disable()`/`context.disable()`/`propagation.disable()` in runtime cleanup. — **Reason**: global, owner-blind removal. The sole exception is immediate context initialization rollback after the same call stack proved Logfire registration succeeded.
- **Rejected**: re-register a new `WebTracerProvider` or refresh only the manual tracer. — **Reason**: one leaves cached global tracers on A; the other splits global/manual/instrumentation paths.
- **Rejected**: swap context managers per generation. — **Reason**: active async contexts and application ownership cannot be migrated safely.
- **Rejected**: support overlapping configurations with last-writer-wins. — **Reason**: teardown and optional-runtime ownership become nondeterministic.

### Validation Baseline

| Command                                         | Status   | Observed result                                                                                                                    |
| ----------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `vp run @pydantic/logfire-browser#test`         | Verified | 9 files, 114 tests pass with verified PRP 023 changes on top of `f57d9ec`; provider mock still masks production global persistence |
| `vp run @pydantic/logfire-browser#typecheck`    | Pending  | Required after implementation                                                                                                      |
| `vp run @pydantic/logfire-browser#build`        | Pending  | Required after implementation                                                                                                      |
| `pnpm run check`                                | Verified | Full repository gate passed after PRP 023; treat its uncommitted R1 diff as protected execution baseline                           |
| Scratch non-caching delegation/global probe     | Verified | Cached/direct tracers switch A -> B; inactive is non-recording; app global and duplicate direct paths survive                      |
| Real-browser Zone/resource reconfiguration path | Missing  | This child creates and runs the direct receipt fixture                                                                             |

### Research Coverage

- **Depth**: Deep.
- **Inspected**: browser configure/cleanup, manual tracer cache, instrumentation registration, metrics ownership, current lifecycle tests/docs, installed trace/context/propagation registration and proxy implementations, duplicate-registration behavior, and scratch delegation behavior.
- **Not inspected**: replay delivery/privacy, telemetry self-observation, metrics degradation, proxy servers, and release tooling because other roadmap children own them.
- **Research confidence**: HIGH — the remaining Zone/browser behavior is an explicit direct acceptance gate, not an unresolved architecture choice.

## Execution Contract

- **Planned at commit**: `f57d9ec`
- **Planning baseline**: preserve all existing untracked plans/reports and the parent roadmap research directory. Verified PRP 023 is present as an uncommitted protected baseline on the planned commit; preserve its URL helpers, immutable endpoint-ignore merge, replay validation, installed-OTel tests, and self-observation fixture while integrating lifecycle changes. Do not stage or rewrite unrelated artifacts.

### Expected Changes

- `packages/logfire-browser/src/providerLifecycle.ts` — page-stable delegating tracer provider, inactive no-op behavior, generation state machine, trace/context/propagation registration ownership, and test reset/factory seams.
- `packages/logfire-browser/src/providerLifecycle.test.ts` — cached tracer switching, generation identity, independent/mixed global ownership, context registration/enable rollback, and inactive spans.
- `packages/logfire-browser/src/providerLifecycle.integration.test.ts` — public `configure()` coverage for all eight external/absent trace-context-propagation combinations against real OpenTelemetry globals/providers.
- `packages/logfire-browser/src/index.ts` and `index.test.ts` — replace concrete provider registration, bind manual tracer, enforce overlap, integrate activation/deactivation with cleanup, remove the masking mock disable, and verify cleanup failure releases the runtime.
- `packages/logfire-browser/README.md` and `docs/packages/browser.md` — document sequential reconfiguration, overlap/context rules, mixed application ownership, unsupported duplicate-bundle reconfiguration, and the span cutoff.
- `packages/logfire-browser/test-fixtures/provider-lifecycle/` — Vite receipt fixture with sequential and application-owned-global pages using built public packages and real Zone context.
- `packages/logfire-browser/package.json` and `pnpm-lock.yaml` — add test-only `@opentelemetry/context-zone`/`zone.js` development dependencies if the fixture cannot consume an existing workspace installation cleanly; no new production dependency.
- `.changeset/browser-provider-reconfiguration.md` — package-visible cleanup/reconfiguration and global-ownership contract for `@pydantic/logfire-browser` (patch within the already planned 0.17.0 minor exit release).

### Explicitly Out of Scope

- Changes to R1 endpoint semantics, replay fetch wrapper metadata, or the verified self-observation acceptance boundary. Nearby R1 code must be preserved while lifecycle integration is added.
- Replay keepalive/compression, privacy defaults, public replay/Web Vitals placement, proxy examples, Changesets null-version repair, or publication.
- Concurrent active configurations, hot-swapping context managers, or migration of live A spans to B.
- Global meter-provider ownership or delegating metrics.
- Defending against another library calling global `disable()` after Logfire has configured.
- Reconfiguration across duplicate physical `@pydantic/logfire-browser` or `logfire` runtimes; consumers must deduplicate them.
- Adding a public provider/delegator option or exposing lifecycle internals.

### Scope Expansion Rule

Additional source files may change only to keep private lifecycle helpers cohesive or create the direct fixture. Pause if implementation needs a new public option, must replace an application-owned global, requires context-manager swapping, changes cleanup step order for optional features, or couples metrics/replay lifecycle beyond calling their existing cleanup handles.

### Pause and Reassess If

- A public-API-only non-recording tracer cannot preserve all `startActiveSpan` overloads without deprecated/deep imports.
- Explicit provider registration cannot keep Logfire manual helpers aligned when an application owns the global.
- The real Zone fixture loses context in B despite retaining the same manager, or a pre-A cached tracer cannot switch resources.
- Successful cleanup cannot prove all SDK-owned instrumentation/exporters stopped, or rejected cleanup does not enter the specified terminal state.
- A package instance cannot distinguish active versus cleaning without changing the public cleanup return shape.
- Implementation reveals overlap beyond the already-audited PRP 023 changes in `index.ts`, `index.test.ts`, the browser development manifest, and lockfile, or cannot preserve their verified behavior.

## Context

### Key Files

- `packages/logfire-browser/src/index.ts` — provider construction, global registration, instrumentation startup, optional runtimes, and cleanup.
- `packages/logfire-browser/src/index.test.ts` — lifecycle mocks and cleanup assertions, including the production-inaccurate global disable.
- `packages/logfire-api/src/logfireApiConfig.ts` — cached tracer used by manual helpers.
- `packages/logfire-browser/src/browserSession.ts` — instance-adjacent session state that makes overlapping configuration unsafe.
- `packages/logfire-browser/src/browserMetrics.ts` — private metrics provider confirming trace-only scope.
- `packages/logfire-browser/README.md` and `docs/packages/browser.md` — public lifecycle contract.
- Installed OTel API trace/context/propagation sources, SDK `WebTracerProvider`, and instrumentation `registerInstrumentations` — ownership and delegation constraints.

### Gotchas

- `trace.getTracer()` before first global registration returns an OpenTelemetry proxy tracer. Once it resolves to the Logfire stable tracer, that stable tracer itself must remain non-caching or the second switch still fails.
- Do not use exported-but-deprecated `ProxyTracerProvider`/`ProxyTracer`; both cache delegates and are planned for removal.
- A non-recording `startActiveSpan()` still must invoke the callback with a non-recording span under the requested/current context and preserve all overload return types.
- Do not call `WebTracerProvider.register()` for generation providers; it installs the concrete provider and repeats context/propagation registration.
- Call context global registration before enabling a proposed manager. If registration fails, do not disable a caller-provided manager because it may be the already active application manager.
- Resolve context ownership before trace/propagation registration or generation activation, so an enable/rollback failure cannot leave a partially active provider generation.
- Bind the manual Logfire tracer before any configured instrumentation/optional runtime can synchronously emit.
- Mark runtime `cleaning` synchronously on the first cleanup call, not after awaiting optional startup, so overlap is rejected for the whole interval.
- Deactivate A after producers/instrumentations have stopped but before `forceFlush()` and `shutdown()`. This prevents new A spans while still draining already-ended spans.
- Release the runtime state in `finally`; preserve the original first cleanup error and cleanup promise identity.
- Never reset page-global lifecycle state in production cleanup. Test reset helpers may use global disable solely in isolated test teardown. The only production disable is same-stack context initialization rollback after registration success proves ownership.

## Implementation Blueprint

### Data Models

```ts
type GenerationState =
  | { status: 'idle' }
  | { status: 'active'; token: symbol; provider: TracerProvider }
  | { status: 'cleaning'; token: symbol; provider: TracerProvider; cleanup: Promise<void> }
  | { status: 'failed'; token?: symbol; error: Error }

type TraceOwnership = { status: 'uninitialized' } | { status: 'logfire' } | { status: 'external' }
type ContextOwnership =
  | { status: 'uninitialized' }
  | { status: 'logfire'; contextManager: ContextManager }
  | { status: 'external' }
  | { status: 'failed'; error: Error }
type PropagationOwnership = { status: 'uninitialized' } | { status: 'logfire' } | { status: 'external' }
```

- `DelegatingTracerProvider.getTracer(scope, version, options)` returns a tracer that reads the current generation provider for every span start.
- `activate(provider)` returns an opaque generation token and fails unless idle.
- `beginCleanup(token, promise)` changes active -> cleaning synchronously.
- `deactivateDelegate(token)` clears only the matching current provider while leaving the generation in `cleaning`, so no new generation can start during trace flush/shutdown.
- `settleCleanup(token, error?)` runs only after every cleanup step has been attempted; matching success changes `cleaning -> idle`, while rejection changes `cleaning -> failed` and preserves the first error.
- Trace/context/propagation ownership states are independent of one another and of generation state. Normal cleanup clears none of them; only an ownership-proven context enable rollback may return context ownership to uninitialized.

### Tasks

```yaml
Task 1: Add failing real-API lifecycle characterization
  MODIFY packages/logfire-browser/src/index.test.ts:
    - Remove trace.disable() from MockWebTracerProvider.shutdown so the mock matches production.
    - Add A -> cleanup -> B assertions showing the current global/manual tracer remains on A while explicit instrumentation receives B before implementation.
    - Add exact overlap checks before cleanup and while a controlled cleanup promise is pending; assert no second exporter/session/instrumentation is created.
    - Extend cleanup-failure cases to assert a later configure throws the exact terminal reload-required error after the rejected promise settles.
    - Assert context/provider initialization failures occur before diagnostics and shared Logfire API settings are mutated, so successful ownership rollback permits a retry without leaked baggage, scrubbing, or minimum-level configuration.
  CREATE packages/logfire-browser/src/providerLifecycle.test.ts:
    - Use the real OTel API with recording providers to characterize pre-registration tracer caching and lower-level independent trace/context/propagation ownership transitions.
    - Account exactly for context candidate set/enable/disable calls: failed registration leaves an explicit candidate untouched; successful registration followed by enable failure attempts ownership-proven rollback; rollback failure becomes terminal.
  CREATE packages/logfire-browser/src/providerLifecycle.integration.test.ts:
    - Import the public browser configure/manual APIs without provider-lifecycle mocks and run all eight external/absent trace-context-propagation combinations in isolated API-global resets.
    - Pre-register recording application owners for each selected subset, configure Logfire without contextManager when context is external, emit application-global and Logfire manual/custom-instrumentation spans, exercise propagation, then await cleanup.
    - Assert each external owner receives the same calls/spans before/during/after cleanup, each absent global is independently registered by Logfire, manual/custom spans use the Logfire generation provider, and runtime cleanup invokes no global disable.
    - Stub only network export at the fetch boundary; do not mock trace/context/propagation registration or WebTracerProvider behavior.
  SUPPORTS: CX-1 through CX-5; expected failures identify the current split and missing overlap/ownership guards.
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-browser#test -- -t "reconfig|overlap|ownership|delegat"
    - EXPECTED: New A -> B routing/ownership assertions fail before implementation while existing cleanup ordering remains green.

Task 2: Implement the page-stable provider lifecycle
  CREATE packages/logfire-browser/src/providerLifecycle.ts:
    - Implement TracerProvider/Tracer interfaces with per-call delegate lookup and public-API-only non-recording spans/active-span callbacks.
    - Implement idle/active/cleaning/failed state, opaque generation tokens, exact overlap/terminal errors, token-checked delegate deactivation that remains cleaning, later success release to idle, and rejected-cleanup transition to failed.
    - Track page-global trace, context, and propagation ownership independently. Resolve context first, then attempt trace and propagation; retain direct provider use when trace registration returns false and register only globals that are actually missing.
    - Install the default StackContextManager and W3C trace+baggage CompositePropagator at most once when their respective global has no external owner; never disable them during normal cleanup.
    - Register a proposed context manager before enabling it; retain/accept the same Logfire-owned identity on later generations and reject different/external explicit requests without touching the candidate.
    - If a just-registered manager throws from enable(), immediately attempt context.disable() as ownership-proven initialization rollback. On rollback success return context ownership to uninitialized; on rollback failure record a terminal reload-required lifecycle error.
    - Export only private package helpers plus a factory/reset seam guarded for tests; do not add a public package export.
  CREATE/MODIFY packages/logfire-browser/src/providerLifecycle.test.ts:
    - Cover every startActiveSpan overload and return value, startSpan arguments/context, inactive recording=false, cached tracer A -> B, resource/sampler provider switching, stale token behavior, and exact state transitions.
    - Cover Logfire-owned default/explicit context, same identity reuse, different identity rejection, external omitted manager, external explicit conflict, enable-throw rollback success/failure, and no runtime global disable.
    - Keep helper-level mixed-ownership tests as diagnostic support; the public integration matrix owns acceptance.
  ENABLES: CX-1, CX-3, CX-4, CX-5
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-browser#test -- -t "provider lifecycle|delegat|context ownership"
    - EXPECTED: Stable tracer, state-machine, independent ownership, and enable-rollback assertions pass.

Task 3: Integrate generations into public configure and cleanup
  MODIFY packages/logfire-browser/src/index.ts:
    - Assert lifecycle idle before configuring diagnostics, API/session/exporter state, then resolve throw-prone context/global ownership and construct the generation provider before mutating diagnostics or shared Logfire API settings.
    - Construct WebTracerProvider without calling register(); initialize page globals through providerLifecycle and activate the concrete provider.
    - Bind logfireApiConfig.tracer to the stable provider tracer before instrumentation, replay, metrics, or Web Vitals startup.
    - Keep registerInstrumentations supplied with the concrete generation provider.
    - Reorder context/global and provider initialization before diagnostics/shared API mutations. If synchronous setup fails after session reservation or activation, perform bounded rollback/deactivation before rethrowing; return to idle only when rollback proves complete, otherwise mark lifecycle failed/terminal.
    - On the first cleanup call, transition active -> cleaning synchronously while preserving the returned promise identity.
    - Preserve replay -> instrumentation -> Web Vitals -> metrics cleanup, then deactivate the matching trace generation before forceFlush/shutdown and clear session state.
    - Deactivate only the matching delegate before trace forceFlush/shutdown while retaining `cleaning`; after every cleanup step has been attempted, settle to idle only on success or failed on rejection, then rethrow the existing first aggregated failure.
  MODIFY packages/logfire-browser/src/index.test.ts:
    - Prove manual helpers, a pre-A cached global tracer when Logfire owns global, Web Vitals' explicit tracer, and custom instrumentation all route A then B.
    - Decode/inspect provider resources and sampler behavior rather than only provider object identity.
    - Assert no recording between generations, exact overlap error/no side effects, cleanup failure terminal behavior, synchronous setup rollback, token safety, and unchanged cleanup order/promise identity.
    - Assert an application-owned trace provider remains global while Logfire manual/custom instrumentation spans still use Logfire's generation provider; require providerLifecycle.integration.test.ts to cover every mixed context/propagation combination through public configure.
  ENABLES: CX-1, CX-2, CX-3, CX-5
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-browser#test -- -t "configure|cleanup|reconfig|global owner"
    - EXPECTED: Public sequential lifecycle, ownership, rollback, and failed-cleanup containment pass with production-accurate providers.

Task 4: Document and release-note the stable lifecycle contract
  MODIFY packages/logfire-browser/README.md:
    - Add an A cleanup -> await -> B example and the exact overlap error rule.
    - Explain page-stable context/global ownership, application-first setup with omitted contextManager, unsupported duplicate-bundle reconfiguration/deduplication requirement, inactive no-op interval, A-span end-before-cleanup cutoff, and reload requirement after rejected cleanup.
    - Retain the existing cleanup ordering and failure aggregation text.
  MODIFY docs/packages/browser.md:
    - Mirror the supported sequential reconfiguration example and contract in user-facing docs.
    - Warn that contextManager cannot be swapped and a caller-owned global manager should be registered before Logfire and omitted from Logfire options.
  CREATE .changeset/browser-provider-reconfiguration.md:
    - Add a patch changeset for @pydantic/logfire-browser describing safe same-page reconfiguration and non-destructive OpenTelemetry ownership.
  ENABLES: R6 lifecycle documentation and stable release metadata.
  VERIFY:
    - COMMAND: vp fmt --check packages/logfire-browser/README.md docs/packages/browser.md .changeset/browser-provider-reconfiguration.md
    - EXPECTED: Lifecycle docs and changeset are formatted and mutually consistent.

Task 5: Build and run direct real-browser lifecycle receipts
  CREATE packages/logfire-browser/test-fixtures/provider-lifecycle/vite.config.ts:
    - Serve loopback-only sequential and application-owned pages plus /traces/a, /traces/b, /traces/app, and scenario receipt/reset routes.
    - Decode OTLP JSON and retain bounded span/resource records; never forward or require credentials.
  CREATE packages/logfire-browser/test-fixtures/provider-lifecycle/index.html and main.ts:
    - Load built public packages, zone.js, and ZoneContextManager.
    - In sequential mode, cache a tracer before A, configure A with Zone and resource generation=A, emit/end cached/manual/custom-instrumentation async parent-child spans, await cleanup, observe non-recording inactive behavior, configure B with generation=B while omitting the manager, repeat, and clean up B.
    - Expose phase/error state; attempt overlap while A is active and cleaning and record the exact contained error.
    - In application-owned mode, register a real application provider/context/propagator first; configure Logfire without contextManager; emit app-global and Logfire manual/custom spans before/during/after Logfire cleanup.
  CREATE packages/logfire-browser/test-fixtures/provider-lifecycle/verify.mjs:
    - For sequential mode, require exact named span sets at A/B endpoints, exact generation resources, valid async parent-child relationships in both generations, zero cross-generation export, and the inactive non-recording/overlap observations.
    - For application-owned mode, require application-global spans before/during/after cleanup only at the app endpoint and Logfire manual/custom spans only at Logfire's endpoint.
    - Fail on duplicate/unexpected spans, missing receipts, phase errors, or any evidence that application globals stopped after Logfire cleanup.
  MODIFY packages/logfire-browser/package.json and pnpm-lock.yaml only if needed:
    - Add @opentelemetry/context-zone and zone.js as development-only fixture dependencies; keep runtime dependency/peer surfaces unchanged.
  ENABLES: CX-1, CX-3, CX-4
  VERIFY:
    - COMMAND: pnpm run build
    - EXPECTED: Public package artifacts are ready for the consumer fixture.
    - COMMAND: vp dev --config packages/logfire-browser/test-fixtures/provider-lifecycle/vite.config.ts --host 127.0.0.1 --port 4176
    - EXPECTED: Loopback fixture and receipt routes start in a managed terminal.
    - COMMAND: agent-browser open http://127.0.0.1:4176/sequential/
    - EXPECTED: Sequential page starts in a fresh real browser realm.
    - COMMAND: agent-browser wait --fn "window.__logfireProviderLifecycle?.phase === 'complete'"
    - EXPECTED: A/inactive/B lifecycle and cleanup complete without page errors.
    - COMMAND: node packages/logfire-browser/test-fixtures/provider-lifecycle/verify.mjs sequential
    - EXPECTED: Cached/manual/instrumentation spans and Zone parents route exactly to A/B with correct resources.
    - COMMAND: agent-browser open http://127.0.0.1:4176/application-owned/
    - EXPECTED: A fresh page registers application globals before Logfire.
    - COMMAND: agent-browser wait --fn "window.__logfireProviderLifecycle?.phase === 'complete'"
    - EXPECTED: Application and Logfire lifecycles complete without page errors.
    - COMMAND: node packages/logfire-browser/test-fixtures/provider-lifecycle/verify.mjs application-owned
    - EXPECTED: Application globals survive and Logfire direct telemetry remains isolated.

Task 6: Run focused and release-oriented gates
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-browser#test
    - EXPECTED: All browser tests pass with real lifecycle coverage.
    - COMMAND: vp run @pydantic/logfire-browser#typecheck
    - EXPECTED: Delegating tracer overloads and lifecycle state narrow without errors.
    - COMMAND: vp run @pydantic/logfire-browser#build
    - EXPECTED: Public artifacts build without exposing private lifecycle modules.
    - COMMAND: node_modules/.bin/changeset status --verbose
    - EXPECTED: Browser remains planned for 0.17.0; this patch changeset introduces no unrelated package bump.
    - COMMAND: pnpm run check
    - EXPECTED: Repository build, lint/check, typecheck, and test gate passes.
```

### Integration Points

```yaml
PUBLIC CONFIGURATION:
  - packages/logfire-browser/src/index.ts — reserves and activates one provider generation, then returns its token-bound cleanup.

MANUAL API:
  - logfireApiConfig.tracer — bound to the page-stable tracer so browser re-exports follow the active generation independently of global ownership.

OPENTELEMETRY GLOBALS:
  - providerLifecycle.ts — attempts first-owner registration once and never performs runtime global teardown.

INSTRUMENTATIONS:
  - registerInstrumentations({ tracerProvider }) — continues receiving the concrete generation provider.

VALIDATION:
  - providerLifecycle.test.ts — state/ownership semantics.
  - index.test.ts — public configure/cleanup composition.
  - test-fixtures/provider-lifecycle — direct browser/Zone/resource/application-owner evidence.
```

## Validation

```bash
vp run @pydantic/logfire-browser#test
vp run @pydantic/logfire-browser#typecheck
vp run @pydantic/logfire-browser#build
vp fmt --check packages/logfire-browser/src packages/logfire-browser/README.md docs/packages/browser.md plans/024-browser-provider-reconfiguration.md
node_modules/.bin/changeset status --verbose
pnpm run check
```

The executor must also run and record Task 5's two exact real-browser receipt scenarios. Unit/JSDOM evidence cannot substitute for Zone async-context continuity or preservation of application-owned globals in a fresh browser realm.

### Required Test Coverage

- [x] Tracer obtained before first registration, manual Logfire tracer, and explicit instrumentation route A -> inactive no-op -> B.
- [x] Every `startActiveSpan` overload preserves arguments, callback return value, context, and inactive non-recording behavior.
- [x] A/B resources and sampler decisions are observed at exported spans, not inferred from object identity.
- [x] Configure overlap before cleanup and during cleanup throws exactly and creates no partial runtime; B succeeds only after fulfilled cleanup.
- [x] Fulfilled cleanup returns to idle; rejected cleanup becomes terminal after every cleanup step; promise identity/error aggregation/order remain unchanged.
- [x] Synchronous setup failure rolls back generation/session/provider state; context enable failure either completes ownership-proven unregister or makes the lifecycle terminal when rollback also fails.
- [x] Public `configure()` across all eight mixed external/absent trace-context-propagation combinations preserves external owners and installs only missing globals; Logfire manual/custom spans still use Logfire's provider.
- [x] Logfire-owned default/explicit context persists; same identity/omission succeeds; different/external explicit conflict is untouched and rejected.
- [x] Existing A span is never migrated; stale generation token cannot detach B.
- [x] Real-browser Zone parent/child continuity works independently in A and B.

### Consumer Verification Plan

| Scenario | Exercise                                                                                                                  | Expected observable evidence                                                                                                          | Environment and prerequisites                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `CX-1`   | Built public package in sequential real-browser fixture; cached/manual/custom async spans in A, cleanup, inactive call, B | Exact A/B endpoint and resource separation; all new emitters switch; inactive is non-recording; Zone parent-child IDs valid           | Node 24, pnpm 11.5.2, Vite loopback, agent-browser, Zone, decoded OTLP, no credentials |
| `CX-2`   | Public configure with active/pending/fulfilled/rejected cleanup controls                                                  | Exact overlap errors/no second setup; B allowed only after fulfillment; rejection yields exact terminal error after all cleanup steps | Browser package test with real providers and controlled processors                     |
| `CX-3`   | Run public `configure()` through all eight real-API mixed ownership combinations; then run an all-external browser page   | Each external owner survives, only missing globals register, app spans continue after cleanup, and Logfire spans remain isolated      | Public integration suite with real API globals plus separate browser realm/receipts    |
| `CX-4`   | Zone manager A -> B, manager identity/conflict cases, and enable-throw rollback success/failure                           | Async context remains valid; external candidates stay untouched; proven rollback unregisters or marks lifecycle terminal exactly      | Real browser for Zone; real API unit boundary for call accounting                      |
| `CX-5`   | Hold A span across boundary and invoke token-checked deactivation around B                                                | A span stays A-owned/non-migrated; new cached span goes B; stale token leaves B active                                                | Real recording providers/processors                                                    |

If either direct browser scenario cannot run, grade its covered acceptance scenarios `UNVERIFIED` and do not advance R2 or the release roadmap.

## Unknowns & Risks

- Implementing a correct inactive `startActiveSpan` across TypeScript overloads is easy to get subtly wrong. Exact overload/return/context tests are mandatory.
- Context APIs do not expose their current manager identity. The conservative explicit-conflict rejection is intentional; do not weaken it to silent acceptance.
- A settled cleanup failure may leave third-party instrumentation partially enabled even though Logfire attempted every step. The package instance therefore remains terminal until page reload; the child does not claim to repair arbitrary third-party teardown.
- Long-lived A spans that end after A shutdown may be dropped by their A processor. This is a documented cutoff, not a migration bug.
- Duplicate bundles may share OpenTelemetry's Symbol-based global and the mutable `logfireApiConfig` while retaining separate module state. Reconfiguration across copies is explicitly unsupported; docs must tell consumers to deduplicate both packages.
- PRP 023 may later modify nearby instrumentation startup code. Execution must rebase the child and preserve both generation lifecycle and endpoint-ignore merging rather than overwrite either contract.

**Confidence: 8/10** for one-pass implementation success. Provider/global behavior is source- and spike-backed; the main execution risks are exact active-span overload behavior and real-browser Zone fixture mechanics.

## Execution Notes

### Scope Expansions

- None. The verified PRP 023 overlap is now an explicit protected baseline rather than future work.

### Execution Progress

- Started on 2026-07-13 at commit `f57d9ec` with verified, uncommitted PRP 023 changes present. Preflight confirmed Node 24.14.1, pnpm 11.5.2, browser 114/114 tests, and a passing repository check from the R1 verification.
- Cold preflight review found and resolved three planning gaps before source edits: the stale R1 baseline, conflated delegate deactivation/cleanup settlement, and undefined shared API-setting behavior on retryable synchronous initialization failure.
- Implemented a page-stable non-caching delegating tracer provider, token-checked generation lifecycle, independent trace/context/propagation ownership, exact overlap and terminal-failure contracts, and ownership-proven context initialization rollback.
- Integrated the lifecycle through public `configure()` and cleanup while retaining explicit concrete providers for instrumentations and preserving the replay -> instrumentation -> Web Vitals -> metrics -> trace cleanup order.
- Added real-API public integration coverage for all eight mixed ownership combinations, focused lifecycle/configure tests, user-facing lifecycle documentation, and a patch changeset. The browser suite now passes 136/136 tests.
- Verified both built-package browser scenarios through decoded loopback OTLP receipts. Sequential A/inactive/B routing produced exact generation resources and valid cached/manual Zone parentage; the application-owned scenario retained app trace/context/propagation after Logfire cleanup.
- `@pydantic/logfire-browser` test, typecheck, and build gates passed. `pnpm run check` passed repository build, formatting/lint, all package typechecks, and all package tests. Changesets still plans browser 0.17.0 and replay 0.1.0; the known private Next.js version artifact remains owned by R8.

### Deviations

- Ownership/context and provider construction will precede diagnostics and shared `logfireApiConfig` mutation. This is the chosen rollback contract: a retryable initialization failure leaves those shared settings unchanged instead of snapshotting and restoring them.
- The public mixed-ownership integration uses a real loopback HTTP receiver with the built-in Node OTLP transport rather than stubbing `fetch`; this is stronger transport-boundary evidence while retaining real OpenTelemetry globals and providers.
- The real-browser fixture performs async parent/child work across a Zone-patched timer callback. Native browser `async`/`await` continuations are not patched by this Zone.js setup, while timer callbacks directly exercise the supported Zone context boundary and pass in both generations.
- Post-activation synchronous setup failure now restores the shared API snapshot, deactivates immediately, remains cleaning until provider shutdown proves rollback success, and becomes terminal if shutdown or session rollback fails.

### Independent Verification

- Post-implementation cold review initially found three gaps: incomplete asynchronous setup rollback, private-surface substitution for public manual/sampler evidence, and a browser-state readiness race. All three were fixed and the second cold review passed with no remaining findings.

### Unresolved Risks

- None.
