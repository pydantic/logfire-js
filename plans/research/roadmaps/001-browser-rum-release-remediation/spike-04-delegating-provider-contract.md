# Spike 04: What exact lifecycle contract makes stable tracer delegation safe?

## Status

CONCLUSIVE

## Question

After selecting same-page reconfiguration, what provider/global-ownership contract lets cached manual and global tracers move from configuration A to B without unregistering application-owned OpenTelemetry globals or allowing stale cleanup to detach B?

## Why It Blocks Planning

Spike 01 proved that delegation is feasible but did not settle concurrent configuration, inactive behavior, custom context-manager ownership, duplicate bundle instances, or how the cached `logfire` API tracer reaches the delegating provider. The R2 child PRP must settle those boundaries rather than leave them to its executor.

## Hypotheses and Decision Rule

- If a non-caching tracer can select the current concrete provider on every span start, tracers obtained before A can route through A and then B.
- If the stable provider can be called directly when another application owns the global trace API, Logfire manual spans and explicitly registered instrumentations can remain aligned without replacing the application provider.
- If two physical browser-package instances may share one deduplicated mutable `logfireApiConfig`, instance-specific manual-helper routing is impossible without a broader core-API architecture; the stable contract must explicitly exclude duplicate-bundle reconfiguration.
- Because trace, context, and propagation register independently, track their ownership independently. Install each at most once and never unregister it during runtime cleanup; reject a later incompatible explicit context-manager request.

## Minimal Experiment

- Environment and exact versions: commit `f57d9ec`; Node.js `24.14.1`; `@opentelemetry/api` `1.9.1`.
- Setup: a scratch non-caching `DelegatingTracerProvider`, recording probe providers A/B, and the real OpenTelemetry global trace API.
- Actions:
  1. Obtain a global tracer before registration and a direct Logfire tracer, activate A, switch to B, then deactivate.
  2. Register an application provider first, attempt Logfire global registration, and emit through the application global and direct Logfire tracer before/after cleanup.
  3. Create two independent delegating-provider instances, attempt both global registrations, emit through each direct tracer, clean up the global owner, and re-check the second instance.
- Observation: registration booleans, provider receiving each span, and whether inactive spans record.
- Safety: scratch code only in `/tmp`; no repository source, dependency, network, or credential changes.

## Evidence

Sequential reconfiguration:

```json
{
  "registered": true,
  "starts": ["A:cached-before:first", "A:manual:first", "B:cached-before:second", "B:manual:second"],
  "inactiveRecording": false
}
```

Application-owned global:

```json
{
  "appRegistered": true,
  "logfireRegistered": false,
  "appStarts": ["app:application:global", "app:application:after-logfire-cleanup"],
  "logfireStarts": ["logfire:manual:direct"]
}
```

Duplicate package instances:

```json
{
  "firstRegistered": true,
  "secondRegistered": false,
  "starts": [
    "bundle-one:application-global:global",
    "bundle-one:manual-one:direct",
    "bundle-two:manual-two:direct",
    "bundle-two:manual-two:after-one-cleanup"
  ],
  "globalAfterCleanupRecording": false
}
```

Source constraints:

- `@opentelemetry/api` 1.9.1 `TraceAPI.setGlobalTracerProvider()` registers a process-global `ProxyTracerProvider` once and returns `false` on later attempts. Its built-in proxy tracers cache the first delegate, so they cannot themselves provide repeated A -> B switching.
- `ContextAPI.setGlobalContextManager()` and `PropagationAPI.setGlobalPropagator()` also return only registration success. Their `disable()` methods unregister the current global without checking ownership.
- `WebTracerProvider.register()` discards all three registration results, enables a proposed context manager before attempting registration, and installs itself rather than a stable provider.
- `registerInstrumentations()` accepts an explicit tracer provider and calls `setTracerProvider()` before enabling instrumentations, so browser instrumentation does not require Logfire to own the global trace API.
- `packages/logfire-api/src/logfireApiConfig.ts` stores a mutable cached tracer in exported `logfireApiConfig`; the browser package can bind that existing slot to a stable delegating tracer without adding a new public option.
- `packages/logfire-browser/src/index.test.ts` currently calls `trace.disable()` from the mock provider's `shutdown()`, masking the real production behavior and requiring replacement with real-API lifecycle coverage.

## Result

- Outcome: CONCLUSIVE.
- Stable contract:
  - One browser-package instance owns one page-lifetime delegating tracer provider and at most one active configuration generation. Multiple/deduplicated browser copies are unsupported for reconfiguration because their manual helpers may share the single mutable `logfireApiConfig.tracer` slot.
  - `configure()` throws deterministically while a prior generation is active or its cleanup is unsettled. A new generation is allowed only after cleanup fulfills. Rejected cleanup leaves the package instance in a terminal failed state because old third-party instrumentation/exporters may still be active; a page reload is required before configuring again.
  - Every delegating tracer looks up the current concrete provider on each `startSpan`/`startActiveSpan`; it is non-recording between generations. Existing tracers therefore switch to B, while spans already started under A remain A-owned and must end before cleanup to be export-guaranteed.
  - Cleanup stops optional producers and instrumentations, deactivates only its own generation before force-flush/shutdown, and never calls `trace.disable()`, `context.disable()`, or `propagation.disable()`.
  - Logfire tries global trace registration once. If another application already owns it, Logfire preserves that owner and binds its cached manual tracer directly to the page-stable delegating provider; explicitly registered browser instrumentations continue receiving the concrete generation provider.
  - Trace, context, and propagation each retain an independent `uninitialized | logfire | external` ownership state. Mixed ownership is supported: Logfire registers only missing globals and preserves every external owner.
  - The first successful Logfire-owned context manager and default propagator remain page-global across generations. A later explicit context manager must be the identical instance; a different instance is rejected. If an application already owns context and no explicit manager is requested, Logfire uses it. Registration must happen before enabling a candidate: failed registration leaves a caller-provided manager untouched. If Logfire proves registration succeeded but `enable()` throws, it may immediately call `context.disable()` only as same-stack ownership-proven rollback. Successful rollback permits a later retry; rollback failure makes lifecycle initialization terminal until reload.
  - The duplicate-runtime scratch result proves only that independent delegators do not need destructive global teardown. It does not prove package-level manual-helper isolation when copies share `logfireApiConfig`; the stable contract tells consumers to deduplicate `@pydantic/logfire-browser`/`logfire` and does not support reconfiguration across copies.
- Rejected alternatives: `WebTracerProvider.register()` per generation; built-in `ProxyTracerProvider`/`ProxyTracer` as the switching layer; blind global disable; silently accepting overlapping configurations; swapping context managers per generation; requiring Logfire to replace an application provider.
- Representativeness limits: the scratch probe used recording fake providers rather than a real browser SDK. Real WebTracerProvider resources/sampling/export, Zone context continuity, instrumentation reuse, and delayed A spans remain mandatory direct acceptance evidence in the child PRP.

## Planning Impact

- R2 can move from BLOCKED to READY FOR PRP and specify the generation state machine, failed-cleanup terminal state, cached-tracer binding, and global ownership rules exactly.
- The child must include real OpenTelemetry tests for pre-registration tracers, manual Logfire helpers, explicit-provider instrumentations, resource/sampler changes, every mixed global-ownership combination, context enable/rollback failure, and cleanup failure. Duplicate package reconfiguration is documented as unsupported rather than proxy-tested as isolated.
- A real-browser Zone-context fixture remains an implementation acceptance gate, not an unresolved architectural decision: the stable manager is not swapped, and span provider selection occurs only when a new span starts.

## Cleanup

- Disposable artifact: `/tmp/logfire-delegating-provider-spike.mjs`.
- Repository and external state: no source, dependency, credential, or external writes; this durable record is the only spike output.
