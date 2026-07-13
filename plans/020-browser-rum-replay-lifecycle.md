## Goal

Stabilize the browser RUM/session replay alpha lifecycle in `@pydantic/logfire-browser` so SDK-owned browser telemetry has one coherent provider/session/replay contract before Platform depends on it.

This is the SDK-side follow-up to [pydantic/platform#26232](https://github.com/pydantic/platform/issues/26232) and the Platform browser RUM/replay PR [pydantic/platform#25595](https://github.com/pydantic/platform/pull/25595). The Platform issue is review-like feedback for the Platform PR, but the highest-leverage fixes belong in the JavaScript SDK first.

The intended outcome is:

- replay correlation is based on the SDK-owned browser session id, not replay chunk `traceIds`
- early browser lifecycle spans can be produced through the configured Logfire provider/session processor when callers use SDK-owned deferred instrumentation setup
- Web Vitals have an explicit SDK contract for spans vs metrics so Platform aggregate views do not accidentally rely on unstable span details
- docs/examples make the safe setup path obvious for alpha users

## Why

- Platform should not patch over SDK lifecycle ordering. If the SDK lets browser auto-instrumentations emit before the Logfire provider/session processor is ready, Platform can only observe inconsistent attributes after ingest.
- Session replay has intentionally moved away from active trace polling. The browser SDK already passes `getSessionId` to replay and deliberately does not pass `getTraceContext`, so Platform should correlate replay windows by `browser.session.id` / `session.id`.
- The current Web Vitals implementation records both spans and optional metrics. Platform aggregate RUM panels should use metrics when configured, while spans remain useful for raw-sample drilldown and exact attribution.
- The current `instrumentations: [getWebAutoInstrumentations(...)]` docs/example shape evaluates the OpenTelemetry helper before `configure()` can register the provider. If those constructors auto-enable instrumentation, the SDK cannot retroactively fix spans emitted during construction.

## Success Criteria

- [ ] `configure()` creates the browser session manager and provider/session span processor before any SDK-owned/deferred RUM instrumentation is constructed.
- [ ] The public API supports deferred instrumentation factories so examples can call `getWebAutoInstrumentations()` after provider registration rather than before `configure()` starts.
- [ ] The public API also supports an opt-in first-class lazy auto-instrumentations option implemented through the same deferred lifecycle path.
- [ ] Existing preconstructed `Instrumentation` inputs continue to work, but docs clearly state that constructor-time spans from preconstructed instrumentations are outside the SDK's control.
- [ ] Web Vitals spans use a tracer from the `WebTracerProvider` built by `configure()`, not `trace.getTracer(...)` global state at callback time.
- [ ] Web Vitals metrics remain the canonical aggregate surface when `metrics.metricUrl` and `rum.webVitals.metrics` are configured. Metric attribute defaults stay low-cardinality.
- [ ] Web Vitals spans remain enabled when `rum.webVitals` is enabled and are available for raw-sample drilldown; do not add a span-disable option in this PRP.
- [ ] Browser session span enrichment stamps `session.id` and `browser.session.id` consistently on SDK-provider spans.
- [ ] URL/page attributes use explicit page-context keys (`logfire.page.url.full`, `logfire.page.url.path`) while preserving `url.full` / `url.path` compatibility during alpha.
- [ ] Replay startup continues to pass the shared browser session id to `@pydantic/logfire-session-replay` and continues not to pass `getTraceContext` from the browser SDK integration.
- [ ] Replay-active span attributes are documented as best-effort state for spans created after replay startup, not as the primary replay correlation mechanism.
- [ ] `examples/browser-rum-replay` and `docs/packages/browser.md` are updated to show the safe alpha setup path.
- [ ] Focused tests cover provider/session ordering, Web Vitals tracer ownership, replay/session contract, URL collision behavior, and cleanup ordering.
- [ ] A changeset documents the package-visible behavior/API clarification for `@pydantic/logfire-browser`.

## Clarifications Needed

These are the points to settle before coding, because they affect public API and Platform expectations.

1. Deferred instrumentation API shape

   Decision recorded: support both deferred instrumentation factories and an opt-in first-class lazy auto-instrumentations option. The first-class option must be implemented through the same deferred lifecycle path; it must not construct auto-instrumentations before the provider/session processor is ready. The SDK should own `@opentelemetry/auto-instrumentations-web` as a direct dependency, but load it lazily only when the first-class option is enabled.

   Extend `instrumentations` to accept factories in addition to existing instances:

   ```ts
   type BrowserInstrumentationInput = Instrumentation | Instrumentation[] | (() => Instrumentation | Instrumentation[])

   interface LogfireConfigOptions {
     instrumentations?: BrowserInstrumentationInput[]
   }
   ```

   The SDK should call factories only after constructing the `WebTracerProvider`, installing `BrowserSessionSpanProcessor`, and registering the provider. This preserves backward compatibility while giving Logfire docs/examples a lifecycle-safe path.

   Add a first-class opt-in lazy auto-instrumentations option on top of that primitive. The option name is top-level `autoInstrumentations?: boolean | AutoInstrumentationsConfig`, colocated with the existing top-level `instrumentations` option.

   Tradeoff: preconstructed third-party `Instrumentation` instances can still emit in their constructor before `configure()` starts. The SDK cannot fully solve that after the fact; it can only document the limitation and make the safe path ergonomic.

2. Web Vitals spans vs metrics

   Decision recorded: keep Web Vital spans enabled whenever `rum.webVitals` is enabled. Do not add `rum.webVitals.spans?: boolean` in this PRP. Metrics are canonical for aggregate Platform RUM panels when configured; spans are for raw-sample drilldown, exact session/page context, and attribution fields.

   Tradeoff: spans have rich per-sample data (`browser.session.id`, exact URL/page context, attribution selectors), but are not ideal for p75 aggregate panels. Metrics are cheaper and semantically better for aggregate RUM, but intentionally omit `browser.session.id`, `session.id`, `url.full`, raw metric id/delta/value attributes, and DOM selectors by default to avoid high-cardinality series.

3. Replay-active attributes on early spans

   Decision recorded: keep replay-active attributes truthful and best-effort. Do not mark `logfire.session_replay.active=true` until replay actually loads, samples in, and reports `recording === true`. Do not add an optimistic or pending replay state in this PRP. Use browser session id plus replay time bounds as the stable replay correlation key for all spans.

   Reasoning: optimistic active attrs would mostly damage product correctness rather than data safety. Platform could show replay affordances or count replay coverage for spans where no replay exists, and startup/sampling failures would be hidden because traces would claim replay was active. With the current replay package defaults (`sessionSampleRate: 1`, `onErrorSampleRate: 1`), sampling-off false positives are unlikely in the alpha example, but production rollouts may lower sampling; with `sessionSampleRate: 0.1`, optimistic marking would be false for roughly 90% of sampled-off sessions during the startup window. Load/import failures are also plausible in browsers because replay is loaded asynchronously.

   Tradeoff: very early document-load/resource spans may not carry replay-active attributes while the optional replay package is still loading. Those spans still correlate to replay by `browser.session.id` and time bounds when a replay exists.

4. URL/page attribute collision policy

   Decision recorded: add explicit Logfire page-context attributes, `logfire.page.url.full` and `logfire.page.url.path`, while preserving current `url.full` / `url.path` compatibility during alpha. Platform should prefer the page-context attributes for page/session grouping once available.

   Current `BrowserSessionSpanProcessor` stamps `url.full` and `url.path` from the current page URL onto every span it sees. This is useful for manual spans and Web Vitals, but can collide with OpenTelemetry fetch/resource spans where `url.full` may mean the requested resource URL. The new page-context attrs distinguish page URL from request/resource URL without breaking alpha consumers that already read `url.*`.

   Tradeoff: this adds a small amount of attribute duplication in the short term. That is preferable to making `url.full` sometimes mean current page URL and sometimes mean network target URL without a stable precedence rule.

## Clarifications

### Session 2026-07-07

- Q: Should the SDK support only deferred instrumentation factories, or also add a first-class auto-instrumentations option? -> A: Support both. Keep deferred instrumentation factories as the generic primitive, and add an opt-in first-class lazy auto-instrumentations option implemented through the same deferred lifecycle path. Do not enable it by default.
- Q: Should the first-class auto-instrumentations option use a direct dependency or optional peer for `@opentelemetry/auto-instrumentations-web`? -> A: Use a direct dependency, but load it lazily only when the first-class option is enabled. Avoid static imports that would pull auto-instrumentation code into the main browser SDK chunk.
- Q: Should Web Vital spans stay enabled when metrics are configured, or should the SDK add a span-disable option now? -> A: Keep Web Vital spans enabled for now. Metrics are the canonical aggregate surface for Platform panels, while spans remain the raw-sample drilldown surface. Do not add `rum.webVitals.spans?: boolean` in this PRP.
- Q: Should replay-active attrs be marked optimistically on early spans while replay is loading? -> A: No. Keep `logfire.session_replay.active/mode` truthful and best-effort: only stamp them after replay actually loads, samples in, and reports recording/buffer mode. Correlate early spans by `browser.session.id` plus replay time bounds. Optimistic marking would create false positives for sampled-off sessions and replay load failures, especially in production rollouts with lower sampling rates.
- Q: How should SDK page URL context avoid colliding with fetch/resource `url.*` semantics? -> A: Add explicit page-context attributes `logfire.page.url.full` and `logfire.page.url.path`, and keep existing `url.full` / `url.path` compatibility during alpha. Platform should prefer the page-context attrs for page/session grouping once available.
- Q: What should the first-class lazy auto-instrumentations option be named and where should it live? -> A: Use top-level `autoInstrumentations?: boolean | AutoInstrumentationsConfig`, colocated with the existing top-level `instrumentations` option. Auto-instrumentations produce browser traces generally, so do not nest it under `rum`.

## Context

### Key Files

- `packages/logfire-browser/src/index.ts` - public browser `configure()` entrypoint, provider/span processor setup, instrumentation registration, metrics/Web Vitals/replay startup, cleanup ordering.
- `packages/logfire-browser/src/BrowserSessionSpanProcessor.ts` - stamps `session.id`, `browser.session.id`, replay state, and URL attributes on span start.
- `packages/logfire-browser/src/browserSession.ts` - browser session storage, rotation, `getBrowserSessionId()`, URL attribute callback.
- `packages/logfire-browser/src/webVitals.ts` - dynamic `web-vitals/attribution` startup, Web Vital span creation, metric recorder handoff.
- `packages/logfire-browser/src/browserMetrics.ts` - OTLP metrics transport and Web Vital histogram names/attributes.
- `packages/logfire-browser/src/sessionReplay.ts` - optional replay package loading, shared session id handoff, telemetry ignore patterns, replay active state.
- `packages/logfire-browser/src/index.test.ts` - configure lifecycle tests and mocks for provider, metrics, replay, Web Vitals, cleanup.
- `packages/logfire-browser/src/BrowserSessionSpanProcessor.test.ts` - current session/url/replay attribute tests.
- `packages/logfire-browser/src/webVitals.test.ts` - current Web Vital span/metric callback tests.
- `packages/logfire-browser/src/browserMetrics.test.ts` - histogram and low-cardinality metric attribute tests.
- `packages/logfire-browser/src/sessionReplay.test.ts` - replay config/session id tests.
- `docs/packages/browser.md` - user-facing browser SDK docs.
- `examples/browser-rum-replay/src/main.ts` - alpha example currently using `instrumentations: [getWebAutoInstrumentations(...)]`.
- `.changeset/` - release metadata for package-visible API/behavior docs.

### External References

- [pydantic/platform#26232](https://github.com/pydantic/platform/issues/26232) - Platform follow-up issue identifying session-id replay correlation and early lifecycle span pairing concerns.
- [pydantic/platform#25595](https://github.com/pydantic/platform/pull/25595) - Platform browser RUM/session replay alpha integration PR.
- [pydantic/logfire-js#152](https://github.com/pydantic/logfire-js/pull/152) - Browser RUM/Web Vitals/session replay SDK alpha work.
- OpenTelemetry JS browser auto-instrumentation helpers - `getWebAutoInstrumentations(...)` constructs instrumentation instances before `configure()` if called inline in the options object.
- OpenTelemetry JS instrumentation lifecycle - `registerInstrumentations(...)` can assign a tracer provider to instrumentation instances, but it cannot undo spans emitted before registration.
- `web-vitals/attribution` - callbacks may fire after page lifecycle events, so the SDK should use a provider-owned tracer rather than global tracer lookup at report time.

### Current Findings

- `@pydantic/logfire-browser@0.17.0-alpha.1` already creates `BrowserSessionSpanProcessor` before constructing `WebTracerProvider` and registers that provider before calling `registerInstrumentations(...)`.
- That ordering is not enough when users pass preconstructed instrumentations, because JavaScript evaluates `getWebAutoInstrumentations(...)` before `configure()` runs.
- `webVitals.ts` currently calls `trace.getTracer('logfire-web-vitals')` inside `reportWebVitalSpan()`. If Logfire cannot become the global provider, or another provider replaces global state, Web Vital spans may bypass the provider/session processor constructed by `configure()`.
- `sessionReplay.ts` intentionally passes `getSessionId` and does not pass `getTraceContext`. This supports Platform moving away from replay chunk `traceIds` for new browser replay correlation.
- `browserMetrics.ts` already keeps metric attributes low-cardinality and disallows `browser.session.id`, `session.id`, `url.full`, raw Web Vital ids/deltas/values, and attribution selectors on metric datapoints.
- The docs currently promise Web Vital spans as the main Web Vitals surface, then describe metrics as parallel optional emission. Platform aggregate views should not infer that span queries are the preferred aggregate path once metrics are enabled.

## Implementation Blueprint

### Data Models / API

Add a deferred instrumentation input type without removing existing support:

```ts
import type { Instrumentation } from '@opentelemetry/instrumentation'

type BrowserInstrumentationInput = Instrumentation | Instrumentation[] | (() => Instrumentation | Instrumentation[])

interface AutoInstrumentationsConfig {
  enabled?: boolean
  // Exact config shape should mirror getWebAutoInstrumentations config.
  // The implementation must use a lazy dynamic import, not a static import.
}

export interface LogfireConfigOptions {
  instrumentations?: BrowserInstrumentationInput[]
  autoInstrumentations?: boolean | AutoInstrumentationsConfig
}
```

Keep the exact exported name flexible if there is already a naming convention in this package. The important behavior is that factories are invoked after provider registration.

Add page URL attributes while preserving alpha compatibility:

```ts
const ATTR_LOGFIRE_PAGE_URL_FULL = 'logfire.page.url.full'
const ATTR_LOGFIRE_PAGE_URL_PATH = 'logfire.page.url.path'
const ATTR_URL_FULL = 'url.full'
const ATTR_URL_PATH = 'url.path'
```

`BrowserSessionSpanProcessor` should stamp the `logfire.page.url.*` keys from the current browser page URL whenever URL attributes are enabled. It should continue to stamp `url.full` and `url.path` during alpha for compatibility, but docs and Platform queries should prefer `logfire.page.url.*` for page grouping.

Change Web Vitals startup to accept a provider-owned tracer:

```ts
import type { Tracer } from '@opentelemetry/api'

interface BrowserWebVitalsStartOptions extends BrowserWebVitalsOptions {
  metricRecorder?: BrowserWebVitalsMetricRecorder
  tracer: Tracer
}
```

`configure()` should pass `tracerProvider.getTracer('logfire-web-vitals')` or an equivalent provider-owned tracer. Avoid `trace.getTracer(...)` in `webVitals.ts` except possibly as an internal fallback for direct test usage if that API remains public.

### Tasks

```yaml
Task 1: Add deferred instrumentation resolution and first-class lazy auto-instrumentations
  MODIFY packages/logfire-browser/src/index.ts:
    - Replace the current `instrumentations?: (Instrumentation | Instrumentation[])[]` option type with a type that also accepts factories.
    - Add a small resolver that invokes function inputs after `tracerProvider.register(...)`.
    - Add `@opentelemetry/auto-instrumentations-web` as a direct dependency of `@pydantic/logfire-browser`.
    - Add top-level `autoInstrumentations?: boolean | AutoInstrumentationsConfig` implemented by appending another deferred factory.
    - Load `@opentelemetry/auto-instrumentations-web` with dynamic import only when the option is enabled; do not statically import it from the package entrypoint.
    - Do not enable first-class auto-instrumentations by default.
    - Flatten resolved instrumentation arrays before calling `registerInstrumentations`.
    - Keep preconstructed instrumentation support unchanged.
  TEST packages/logfire-browser/src/index.test.ts:
    - Assert instrumentation factories are not invoked before `providerRegister`.
    - Assert factories are invoked before `registerInstrumentations` returns an unregister function.
    - Assert the first-class auto-instrumentations option is also constructed only after `providerRegister`.
    - Assert resolved instrumentations are passed to `registerInstrumentations` with the configured tracer provider.
    - Assert preconstructed instrumentation arrays still pass through.

Task 2: Make Web Vitals use the configured provider
  MODIFY packages/logfire-browser/src/webVitals.ts:
    - Add a required or internally required `tracer` option.
    - Store/use that tracer in the Web Vital callback path instead of `trace.getTracer(...)`.
    - Keep metric recorder behavior unchanged.
    - Revisit module-level `startupPromise` / `currentMetricRecorder` globals so repeated `configure()` calls cannot accidentally keep an old tracer while replacing the metric recorder.
  MODIFY packages/logfire-browser/src/index.ts:
    - Pass `tracerProvider.getTracer('logfire-web-vitals')` into `startBrowserWebVitals(...)`.
  TEST packages/logfire-browser/src/webVitals.test.ts:
    - Replace global `trace.getTracer` expectations with an injected tracer mock.
    - Assert reported spans use the injected tracer.
    - Assert startup deduplication does not pair a new metric recorder with a stale tracer in a way that violates cleanup semantics.
  TEST packages/logfire-browser/src/index.test.ts:
    - Assert Web Vitals startup receives a provider-owned tracer.

Task 3: Lock down session/replay correlation contract
  MODIFY packages/logfire-browser/src/sessionReplay.ts:
    - Keep `getSessionId: () => browserSessionManager.peekSessionId()`.
    - Keep `getTraceContext` excluded from `createReplayConfig`.
    - Add or strengthen comments/tests explaining that replay correlation is by browser session id.
  TEST packages/logfire-browser/src/sessionReplay.test.ts:
    - Keep the existing `not.toHaveProperty('getTraceContext')` assertion.
    - Add an assertion that replay startup touches the browser session before loading the optional package and that replay config uses the same id as spans.
  DOCS docs/packages/browser.md:
    - State that replay chunks and spans correlate by `browser.session.id` / `session.id`.
    - State that replay chunk `traceIds` are legacy/compat metadata, not the SDK browser integration contract.

Task 4: Add explicit page URL context attributes
  MODIFY packages/logfire-browser/src/BrowserSessionSpanProcessor.ts:
    - Stamp `logfire.page.url.full` and `logfire.page.url.path` from the current browser page URL whenever URL attributes are enabled.
    - Continue stamping `url.full` and `url.path` during alpha for compatibility.
    - Keep the existing URL sanitization callback as the single source of sanitized full/path values for both compatibility and page-context attrs.
    - Do not rely on `url.full` / `url.path` for Platform page grouping once page-context attrs are available.
  TEST packages/logfire-browser/src/BrowserSessionSpanProcessor.test.ts:
    - Cover manual/Web Vital-like spans receiving both page-context attrs and compatibility `url.*` attrs.
    - Cover fetch/resource-like spans where `logfire.page.url.*` provides page context even if request/resource instrumentation owns `url.*` semantics.
    - Cover sanitized URL callback behavior for both page-context and compatibility attrs.
  DOCS docs/packages/browser.md:
    - Explain the distinction between page URL context (`logfire.page.url.*`) and request/resource URL context (`url.*`).
    - Document `url.*` as alpha compatibility for current page context, not the preferred Platform grouping key.

Task 5: Update example and docs to safe lifecycle path
  MODIFY examples/browser-rum-replay/src/main.ts:
    - Change inline `getWebAutoInstrumentations(...)` construction to the deferred instrumentation shape selected above.
    - Keep metrics + Web Vitals example configured because Platform aggregate RUM should exercise metrics.
  MODIFY docs/packages/browser.md:
    - Update basic browser configure examples to use deferred instrumentation construction.
    - Clarify that preconstructed instrumentations are still accepted, but may have constructor-time lifecycle limitations.
    - Clarify Web Vitals aggregate-vs-drilldown contract.

Task 6: Release metadata
  CREATE .changeset/<descriptive-name>.md:
    - Bump `@pydantic/logfire-browser` according to the package policy for alpha API behavior changes.
    - Mention deferred instrumentation setup, provider-owned Web Vital spans, and clarified replay correlation.
```

### Integration Points

```yaml
BROWSER TRACE PROVIDER:
  - packages/logfire-browser/src/index.ts creates `WebTracerProvider` and owns the session span processor order.

AUTO-INSTRUMENTATION:
  - Caller code often imports `getWebAutoInstrumentations` from `@opentelemetry/auto-instrumentations-web`.
  - The SDK should provide a deferred construction path and a first-class opt-in lazy auto-instrumentations option.
  - `@pydantic/logfire-browser` should own `@opentelemetry/auto-instrumentations-web` as a direct dependency, loaded via dynamic import only when the first-class option is enabled.

WEB VITALS:
  - packages/logfire-browser/src/webVitals.ts creates spans whenever `rum.webVitals` is enabled and optionally records metrics.
  - packages/logfire-browser/src/browserMetrics.ts owns histogram names and low-cardinality metric attrs.
  - Metrics are the Platform aggregate query surface when configured; spans are the raw-sample drilldown surface.

SESSION REPLAY:
  - packages/logfire-browser/src/sessionReplay.ts bridges SDK session identity to `@pydantic/logfire-session-replay`.
  - packages/logfire-session-replay/* should not need changes unless implementation uncovers a direct package mismatch.

PLATFORM CONTRACT:
  - Platform replay detail should query spans by `browser.session.id` within replay time bounds.
  - Platform Web Vitals aggregate panels should query metric histograms when metrics are enabled.
  - Platform should keep replay chunk `trace_ids` only for legacy/compat display paths, not new browser correlation.
  - Platform should prefer `logfire.page.url.*` over `url.*` for page grouping once the SDK emits those attrs.
```

## Validation

Run focused package checks first:

```bash
vp run @pydantic/logfire-browser#test
vp run @pydantic/logfire-browser#typecheck
vp run @pydantic/logfire-browser#build
```

If `packages/logfire-session-replay` is touched:

```bash
vp run @pydantic/logfire-session-replay#test
vp run @pydantic/logfire-session-replay#typecheck
vp run @pydantic/logfire-session-replay#build
```

Run broader checks before handoff if package exports/docs/examples changed substantially:

```bash
pnpm run build
pnpm run format-check
```

### Required Test Coverage

- [ ] Configure ordering: provider/register/session processor exists before deferred instrumentation factories run.
- [ ] Deferred factory support: factory-returned single instrumentation and array instrumentation inputs both register correctly.
- [ ] First-class auto-instrumentations support: opt-in option dynamically imports and constructs auto-instrumentations lazily after provider registration and is disabled by default.
- [ ] Backward compatibility: preconstructed instrumentation instances still register correctly.
- [ ] Web Vitals tracer ownership: Web Vital spans start from the injected/provider-owned tracer, not the global `trace` singleton.
- [ ] Web Vitals metrics: existing histogram names, units, bucket advice, and low-cardinality attr filtering remain unchanged.
- [ ] Web Vitals span contract: spans continue to be emitted for enabled Web Vitals even when metrics are also configured.
- [ ] Repeated startup/cleanup: Web Vitals module globals do not leak a stale tracer/recorder across repeated `configure()` calls in tests or SPA teardown/setup.
- [ ] Replay session id: replay config uses the same browser session id source as spans and still omits `getTraceContext`.
- [ ] Replay active state: spans before replay startup do not falsely claim replay is active; spans after sampled-in replay startup include active/mode attrs.
- [ ] Replay false-positive coverage: tests or docs cover sampled-off/load-failure behavior so optimistic active attrs are not introduced accidentally.
- [ ] URL/page attrs: `logfire.page.url.full/path` and compatibility `url.full/path` are covered for manual spans and fetch/resource-like spans.
- [ ] Docs/example compile after the deferred instrumentation API change.

## Unknowns & Risks

- OpenTelemetry browser instrumentation constructor behavior varies by package/version. The implementation should prove the desired ordering with package-level unit tests and, ideally, one browser example smoke test rather than assuming all instrumentation behaves the same way.
- A deferred instrumentation factory fixes SDK-documented setup, but cannot fix spans emitted by already-constructed third-party instrumentation instances before `configure()` is called.
- Direct dependency on `@opentelemetry/auto-instrumentations-web` increases installed package size, but dynamic import should keep the runtime/browser bundle cost opt-in for consumers who enable the first-class option.
- Adding `logfire.page.url.*` requires coordinated Platform query updates to prefer the new page-context keys. Keeping `url.*` compatibility during alpha reduces migration risk.
- Web Vitals startup currently uses module-level state. Passing a tracer into that module may expose stale-provider behavior in repeated configure/cleanup tests; that is a useful bug to fix, but it may make the change larger than a one-line tracer injection.
- If Web Vital span volume later proves too expensive, add a separate follow-up to introduce a span-disable option and coordinate Platform raw-sample drilldown behavior. This PRP intentionally keeps spans enabled.
- Very early document-load spans might still be impossible to pair with replay-active attrs without optimistic state. This is acceptable if replay correlation is based on browser session id and replay-active attrs are documented as advisory.

## Suggested Platform Sequence After SDK

After this SDK PR lands and an alpha is published, Platform should consume it before making broad RUM/replay assumptions:

1. Update Platform package versions and example integration to the deferred instrumentation API.
2. Change replay detail trace correlation to query spans by `browser.session.id` within replay time bounds, while keeping chunk `trace_ids` as legacy metadata.
3. Switch RUM Web Vitals aggregate queries to metric histograms (`logfire.browser.web_vital.*`) when the browser metrics transport is configured.
4. Use Web Vital spans for raw sample/detail drilldown only where exact attribution/session/page context is needed.
5. Document the resolved SDK/Platform decisions back on [pydantic/platform#26232](https://github.com/pydantic/platform/issues/26232) for the original issue author, including deferred/lazy instrumentation, Web Vitals metrics-vs-spans, replay-active truthfulness, and replay correlation by session id/time bounds.

## Issue Handoff

After clarification is complete, document the final decisions on [pydantic/platform#26232](https://github.com/pydantic/platform/issues/26232) for the original issue author. The note should be concise and should cover:

- SDK will add deferred instrumentation factories plus top-level `autoInstrumentations?: boolean | AutoInstrumentationsConfig`.
- `@opentelemetry/auto-instrumentations-web` will be a direct dependency but dynamically imported only when enabled.
- Web Vital spans remain enabled; metrics are the canonical Platform aggregate surface when configured.
- Replay-active attrs are truthful/best-effort only; early spans correlate to replay by `browser.session.id` and replay time bounds.
- Page grouping should move to `logfire.page.url.full/path`, with `url.full/path` retained as alpha compatibility.
- Platform should keep replay chunk `trace_ids` as legacy/compat metadata, not the new browser replay correlation contract.

## Confidence

7/10 for a clean SDK implementation once the four clarification points are settled.

The main uncertainty is not the code shape; it is the public contract around deferred instrumentation and URL/page attributes. The provider-owned Web Vitals tracer and replay session-id contract are straightforward.
