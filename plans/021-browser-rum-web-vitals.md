# Browser RUM Web Vitals

## Goal

Add opt-in browser Web Vitals reporting to `@pydantic/logfire-browser` as the
next RUM layer after browser session identity.

The end state is:

- `LogfireConfigOptions.rum` accepts a `webVitals` option.
- When `rum.webVitals` is enabled, the browser SDK records LCP, INP, CLS, FCP,
  and TTFB using `web-vitals/attribution`.
- Each reported metric is emitted as an OpenTelemetry span with stable
  `web_vital.*` attributes that Logfire Platform can query with p75-style SQL.
- Web Vital spans get the browser session and URL attributes from PRP 020 when
  session identity is enabled or implied by web-vitals RUM.
- Existing browser SDK behavior is unchanged when `rum.webVitals` is omitted.

This PRP deliberately does not add OpenTelemetry metrics export, session replay,
automatic web auto-instrumentation defaults, Platform migration, or public
`rum: true`.

Native Web Vitals metrics should be handled by a follow-up PRP that emits
metrics in parallel with these spans. Metrics should not replace spans because
spans preserve raw samples, session/replay correlation, exact URL context, and
attribution selectors for drilldown.

## Why

- Platform's current RUM POC already emits Web Vitals spans and expects
  queryable fields such as `web_vital.name`, `web_vital.value`, and
  `web_vital.rating`.
- The SDK should own Web Vitals capture so browser RUM is not Platform-specific
  glue code.
- Spans are the shortest compatibility path because Platform already reads Web
  Vital samples from Logfire records and can compute p75 over
  `web_vital.value`. They also preserve raw per-page samples with session and
  URL attributes for drilldown.
- Native metrics are intentionally deferred because the browser package
  currently configures traces only. Adding metrics would require browser metric
  SDK/exporter wiring, proxy/docs for `/v1/metrics`, cleanup lifecycle, and a
  Logfire UI/query contract for metric instruments.
- Web Vitals can later be emitted as native metrics too, but that should be a
  separate PRP and should emit in parallel with spans, not instead of spans.
  Histogram vs gauge, temporality, dimensions, and the Perses/Platform query
  contract are not settled by the current Platform POC.
- `web-vitals/attribution` adds useful "what to fix" fields, such as the LCP
  target, INP interaction target, and CLS largest shift target, without creating
  a high-volume event stream.

## Success Criteria

- [ ] `LogfireConfigOptions.rum` accepts `webVitals?: boolean |
BrowserWebVitalsOptions`.
- [ ] `packages/logfire-browser` has an intentional `web-vitals` dependency
      pinned through the workspace catalog.
- [ ] `web-vitals/attribution` is loaded only when `rum.webVitals` is enabled.
- [ ] `rum.webVitals` registers LCP, INP, CLS, FCP, and TTFB callbacks once per
      page lifecycle.
- [ ] Each Web Vital report creates one short OpenTelemetry span named
      `web_vital.<metric-name-lowercase>`.
- [ ] Web Vital spans include `web_vital.name`, `web_vital.value`,
      `web_vital.delta`, `web_vital.id`, `web_vital.rating`, and
      `web_vital.navigation_type`.
- [ ] Web Vital spans include the agreed attribution fields for LCP, INP, CLS,
      FCP, and TTFB, skipping undefined values and complex PerformanceEntry
      objects.
- [ ] Web Vital spans receive PRP 020 session and URL attributes when session
      identity is enabled or implied.
- [ ] Existing behavior is unchanged when `rum.webVitals` is omitted or false.
- [ ] Browser README/docs describe `rum.webVitals`, dependency behavior,
      emitted attributes, and the spans-first limitation.

## Context

### Key Files

- `packages/logfire-browser/src/index.ts` - owns `configure()`,
  `LogfireConfigOptions`, tracer provider setup, PRP 020 session processor
  wiring, cleanup, and the `rum` option.
- `packages/logfire-browser/src/browserSession.ts` - currently defines
  `RUMOptions` and browser session config/types. This PRP should extend that
  type or move broader RUM types into a new `rum.ts` module if that keeps
  ownership clearer.
- `packages/logfire-browser/src/BrowserSessionSpanProcessor.ts` - stamps
  `session.id`, `browser.session.id`, `url.full`, and `url.path` on spans.
  Web Vital spans should flow through this processor when session identity is
  active.
- `packages/logfire-browser/src/index.test.ts` - existing provider
  construction tests. Add configure-level tests for enabling Web Vitals,
  processor/session implications, and cleanup behavior.
- `packages/logfire-browser/src/browserSession.test.ts` and
  `packages/logfire-browser/src/BrowserSessionSpanProcessor.test.ts` - PRP 020
  tests that define session behavior and can guide test style.
- `packages/logfire-browser/package.json` - add `web-vitals` as a dependency.
- `pnpm-workspace.yaml` and `pnpm-lock.yaml` - add/update the catalog and
  lockfile entry for `web-vitals`.
- `packages/logfire-browser/README.md` - package-level public API docs.
- `docs/packages/browser.md` - docs-site browser package docs.
- `examples/browser/src/main.ts` - vanilla browser example. Add `rum.webVitals`
  if it stays readable.
- `examples/nextjs-client-side-instrumentation/app/components/ClientInstrumentationProvider.tsx`
  - optional example update if client-side RUM docs need a framework example.
- `../platform/src/services/logfire-frontend/src/packages/instrumentation/web-vitals.ts`
  - Platform POC pattern for span names and Platform-compatible attributes.
- `../platform/src/services/logfire-frontend/src/app/rum/rum-queries.ts` -
  Platform RUM page queries Web Vitals from `records`, using
  `span_name LIKE 'web_vital.%'` and `approx_percentile_cont` over
  `attributes->>'web_vital.value'`.
- `../platform/src/services/logfire-frontend/src/packages/instrumentation/init-instrumentation.tsx`
  - Platform POC integration showing Web Vitals under the same RUM feature flag
    as session identity and web auto-instrumentation.
- `../platform/src/services/logfire-backend/logfire_backend/routes/v1/metrics.py`
  - Platform added `/v1/metrics/browser` as a browser metric proxy, but the
    current Web Vitals frontend POC does not emit or query Web Vitals through
    this path.
- `docs/rum-session-replay-prp-roadmap.md` - umbrella roadmap that defines this
  PRP as 021.

### External References

- https://www.npmjs.com/package/web-vitals - package metadata; latest checked
  on 2026-06-29 is `5.3.0`.
- https://github.com/GoogleChrome/web-vitals - source and README for the
  current API.
- https://github.com/GoogleChrome/web-vitals/blob/main/README.md#attribution -
  `web-vitals/attribution` behavior and attribution options.
- https://web.dev/articles/vitals - Core Web Vitals definitions and thresholds.

### Gotchas

- `web-vitals` warns not to call `onCLS()`, `onINP()`, `onLCP()`, etc. more
  than once per page load because each call registers observers/listeners for
  the page lifetime. The SDK must guard against duplicate registration if
  `configure()` is called more than once.
- The `web-vitals` callbacks do not provide unregister handles. Browser SDK
  cleanup can no-op for Web Vitals, but it should not allow a later configure to
  double-register observers in the same page.
- `web-vitals/attribution` v5 uses `metric.attribution.target` for LCP. The
  Platform POC used `metric.attribution.element`; do not copy that field access.
  Emit Platform-compatible `web_vital.lcp.element` from `target` only if
  compatibility is needed.
- INP attribution can include `processedEventEntries`, which can be large. Do
  not serialize PerformanceEntry arrays or objects into span attributes.
- Attribute values must be OpenTelemetry primitive attribute values. Skip
  undefined values and avoid object/entry attributes.
- Some metrics may never report in a page lifecycle. INP requires user
  interaction; CLS/FCP/LCP may not report for pages loaded in the background.
  Tests should trigger callbacks directly through mocked `web-vitals`.
- Some callbacks can run more than once, especially after visibility changes or
  back/forward cache restores. Include `web_vital.id` and `web_vital.delta` so
  Platform can dedupe or aggregate if needed.
- This PRP should not make `rum: true` public. Keep the explicit shape
  `rum: { webVitals: true }` or `rum: { webVitals: { ... } }`.
- Browser auto-instrumentations remain caller-configured in this PRP. Do not
  auto-install document-load/fetch/click instrumentation as part of Web Vitals.
- Do not introduce browser OTel metrics as an incidental addition to this PRP.
  Metrics require `@opentelemetry/sdk-metrics`, an OTLP metric exporter/reader,
  `/v1/metrics` proxy guidance, and a product decision on instrument shape.
  Treat that as a follow-up PRP if the Platform/UI contract needs native
  metrics.
- Platform's merged backend does include `/v1/metrics/browser`, so the server
  side can proxy browser OTLP metrics. That is not the same as the frontend RUM
  implementation emitting Web Vitals metrics; the current RUM UI reads Web
  Vitals from `records`.
- In modern SPAs, standard Web Vitals are document/page-lifecycle measurements,
  not route-level soft-navigation measurements. This PRP should document that
  `rum.webVitals` does not create per-route Core Web Vitals yet; a later
  soft-navigation/route instrumentation PRP can add that behavior when the API
  and Platform contract are explicit.

## Implementation Blueprint

### Data Models

```ts
export interface BrowserWebVitalsOptions {
  /**
   * Report metric changes instead of only final reportable values.
   * Defaults to false.
   */
  reportAllChanges?: boolean
  /**
   * Customize how DOM targets are stringified by `web-vitals/attribution`.
   */
  generateTarget?: (element: Node | null) => string | undefined
  /**
   * Whether INP attribution should include processed event entries internally.
   * Defaults to false to reduce memory pressure; entries are not exported as
   * span attributes either way.
   */
  includeProcessedEventEntries?: boolean
}

export interface RUMOptions {
  session?: boolean | BrowserSessionOptions
  webVitals?: boolean | BrowserWebVitalsOptions
}
```

Recommended attribute model:

```ts
interface WebVitalBaseAttributes {
  'web_vital.name': 'CLS' | 'FCP' | 'INP' | 'LCP' | 'TTFB'
  'web_vital.value': number
  'web_vital.delta': number
  'web_vital.id': string
  'web_vital.rating': 'good' | 'needs-improvement' | 'poor'
  'web_vital.navigation_type': string
}
```

Recommended attribution fields:

- LCP:
  - `web_vital.lcp.target`
  - `web_vital.lcp.element` as a Platform compatibility alias for `target`
  - `web_vital.lcp.url`
  - `web_vital.lcp.time_to_first_byte`
  - `web_vital.lcp.resource_load_delay`
  - `web_vital.lcp.resource_load_duration`
  - `web_vital.lcp.element_render_delay`
- INP:
  - `web_vital.inp.target`
  - `web_vital.inp.interaction_type`
  - `web_vital.inp.interaction_time`
  - `web_vital.inp.input_delay`
  - `web_vital.inp.processing_duration`
  - `web_vital.inp.presentation_delay`
  - `web_vital.inp.load_state`
  - optional numeric long-animation-frame summary fields only if easily mapped
    without exporting objects.
- CLS:
  - `web_vital.cls.largest_shift_target`
  - `web_vital.cls.largest_shift_time`
  - `web_vital.cls.largest_shift_value`
  - `web_vital.cls.load_state`
- FCP:
  - `web_vital.fcp.time_to_first_byte`
  - `web_vital.fcp.first_byte_to_fcp`
  - `web_vital.fcp.load_state`
- TTFB:
  - `web_vital.ttfb.waiting_duration`
  - `web_vital.ttfb.cache_duration`
  - `web_vital.ttfb.dns_duration`
  - `web_vital.ttfb.connection_duration`
  - `web_vital.ttfb.request_duration`

### Tasks

```yaml
Task 1: Add Dependency
  MODIFY pnpm-workspace.yaml:
    - Add `web-vitals: ^5.3.0` to the catalog.
  MODIFY packages/logfire-browser/package.json:
    - Add `web-vitals: catalog:` to dependencies.
  UPDATE pnpm-lock.yaml:
    - Run the repo dependency install/update command after package metadata
      changes.
  DECISION:
    - Use a direct package dependency, not an optional peer dependency, because
      Web Vitals is a first-class browser RUM feature and the package is small.
      Still load it dynamically so baseline browser SDK bundles do not execute
      or observe Web Vitals unless configured.

Task 2: Add Web Vitals Module
  CREATE packages/logfire-browser/src/webVitals.ts:
    - Define BrowserWebVitalsOptions.
    - Implement `startBrowserWebVitals(options?: BrowserWebVitalsOptions)`.
    - Dynamically import `web-vitals/attribution`.
    - Register onLCP, onINP, onCLS, onFCP, and onTTFB once per page lifecycle.
    - Start spans with `trace.getTracer('logfire-web-vitals')`.
    - Name spans `web_vital.${metric.name.toLowerCase()}`.
    - Set base `web_vital.*` attributes on every span.
    - Set metric-specific attribution attributes from v5 attribution fields.
    - Skip undefined values and complex PerformanceEntry objects.
    - Catch/report callback errors through `diag.error` without throwing into
      page code.
    - Provide an internal test-only reset helper if needed.
  PATTERN:
    - ../platform/src/services/logfire-frontend/src/packages/instrumentation/web-vitals.ts
    - packages/logfire-browser/src/BrowserSessionSpanProcessor.ts

Task 3: Extend RUM Options
  MODIFY packages/logfire-browser/src/browserSession.ts OR CREATE packages/logfire-browser/src/rum.ts:
    - Add `BrowserWebVitalsOptions`.
    - Extend `RUMOptions` with `webVitals?: boolean | BrowserWebVitalsOptions`.
    - Keep `rum.session` API from PRP 020 unchanged.
  MODIFY packages/logfire-browser/src/index.ts:
    - Import/export BrowserWebVitalsOptions.
    - Resolve `rum.webVitals` to undefined/options.
    - Start Web Vitals only after tracer provider registration.
    - Keep `configure()` synchronous by starting dynamic import in the
      background and storing its promise for cleanup/error logging.
    - Ensure cleanup awaits the Web Vitals startup promise and runs its no-op
      shutdown step if a handle exists.
    - Ensure Web Vital spans can receive session attributes. Recommended
      behavior: `rum.webVitals` should imply default `rum.session` unless the
      user supplies explicit session options.
  GOTCHA:
    - If `rum.webVitals` is true and `rum.session` is explicitly false, clarify
      whether to reject, warn, or honor the explicit false before execution.

Task 4: Add Tests
  CREATE packages/logfire-browser/src/webVitals.test.ts:
    - Mock `web-vitals/attribution` callbacks.
    - Assert callbacks are registered for LCP, INP, CLS, FCP, and TTFB.
    - Trigger each callback and assert span names and base attributes.
    - Assert LCP uses `attribution.target` and optionally emits
      `web_vital.lcp.element` compatibility alias.
    - Assert INP/CLS/FCP/TTFB attribution mappings.
    - Assert undefined attribution values are skipped.
    - Assert complex PerformanceEntry objects are not exported.
    - Assert duplicate `startBrowserWebVitals()` calls do not register duplicate
      observers.
  MODIFY packages/logfire-browser/src/index.test.ts:
    - Assert `rum.webVitals` starts Web Vitals only when enabled.
    - Assert omitted/false `rum.webVitals` preserves existing behavior.
    - Assert `rum.webVitals` is ordered after tracer provider registration.
    - Assert session processor is included when Web Vitals implies session.
    - Assert cleanup awaits Web Vitals startup/shutdown without breaking existing
      cleanup memoization.

Task 5: Update Documentation and Examples
  MODIFY packages/logfire-browser/README.md:
    - Document `rum.webVitals`.
    - Show `rum: { webVitals: true }`.
    - Explain emitted spans and key attributes.
    - Explain that `web-vitals/attribution` is dynamically loaded only when
      enabled.
    - Explain that this PRP emits spans, not OTel metrics.
  MODIFY docs/packages/browser.md:
    - Add the same public API guidance in docs-site form.
  MODIFY examples/browser/src/main.ts:
    - Add `webVitals: true` under the existing `rum` object if the example
      remains readable.
  OPTIONAL MODIFY examples/nextjs-client-side-instrumentation/app/components/ClientInstrumentationProvider.tsx:
    - Add a minimal `rum: { session: true, webVitals: true }` example if docs
      should show framework usage.

Task 6: Add Release Note
  CREATE .changeset/[generated-name].md:
    - Add a minor changeset for `@pydantic/logfire-browser`.
    - Mention opt-in `rum.webVitals` spans.
```

### Integration Points

```yaml
CONFIG:
  - packages/logfire-browser/src/index.ts
    Add `rum.webVitals` and start the Web Vitals observer layer only when
    configured.

SESSION ATTRIBUTES:
  - packages/logfire-browser/src/index.ts
    Ensure `rum.webVitals` can enable or reuse the PRP 020 session processor so
    vital spans get `session.id`, `browser.session.id`, `url.full`, and
    `url.path`.

WEB VITALS:
  - packages/logfire-browser/src/webVitals.ts
    Own all `web-vitals/attribution` imports and mapping logic.

PACKAGE METADATA:
  - pnpm-workspace.yaml
  - pnpm-lock.yaml
  - packages/logfire-browser/package.json

DOCS:
  - packages/logfire-browser/README.md
  - docs/packages/browser.md
  - examples/browser/src/main.ts
```

No backend, database, Platform, or replay package changes are part of this PRP.

## Validation

Run these from the repository root:

```bash
vp run @pydantic/logfire-browser#test
vp run @pydantic/logfire-browser#typecheck
vp run @pydantic/logfire-browser#build
vp run @pydantic/logfire-browser#lint
vp fmt --check
```

For dependency/lockfile and broader confidence before PR:

```bash
vp install
vp run --filter "./packages/*" build
pnpm run check
```

If this environment's `pnpm` shim reports the wrong Node version, prefer the
direct `vp` commands above and note the environment issue in the execution
summary.

### Required Test Coverage

- [ ] `rum.webVitals` omitted: no `web-vitals/attribution` import/start.
- [ ] `rum.webVitals: false`: no Web Vitals start.
- [ ] `rum.webVitals: true`: registers LCP, INP, CLS, FCP, and TTFB callbacks.
- [ ] `rum.webVitals: { reportAllChanges: true }`: passes `reportAllChanges` to
      all callbacks.
- [ ] `generateTarget` option is passed to attribution callbacks.
- [ ] INP `includeProcessedEventEntries` defaults to false and can be
      overridden.
- [ ] Each metric callback creates one span with the expected name and base
      attributes.
- [ ] LCP attribution maps from `attribution.target`, not the old POC
      `element` field.
- [ ] INP, CLS, FCP, and TTFB attribution fields are mapped and undefined values
      are skipped.
- [ ] Complex PerformanceEntry objects are not set as span attributes.
- [ ] Duplicate starts do not register duplicate observers in one page
      lifecycle.
- [ ] Web Vital spans receive browser session and URL attributes when session
      identity is enabled or implied.
- [ ] Cleanup remains idempotent and memoized.

## Clarifications

### Session 2026-06-29

- Q: Why not emit OpenTelemetry metrics in this PRP? -> A: Use spans first
  because that matches the current Platform POC and immediately gives Logfire
  raw Web Vital samples with session and URL attributes for p75 queries and
  drilldown. Native browser metrics would expand the scope from Web Vitals
  capture into metric SDK/exporter setup, `/v1/metrics` proxy docs, lifecycle
  handling, and a product contract for histogram/gauge dimensions and UI
  queries. Metrics remain a good follow-up once that contract is explicit.
- Q: Does the merged Platform RUM change already deal with metrics? -> A:
  Partially. Platform added a browser metrics proxy endpoint
  `/v1/metrics/browser`, and the longer RUM plan mentions a future Perses
  dashboard once Web Vitals metrics are emitted. But the active frontend Web
  Vitals implementation emits spans, and the RUM page queries `records` for
  `span_name LIKE 'web_vital.%'`. So PRP 021 should match the active span path,
  while leaving native metrics as a follow-up that can use the existing backend
  proxy.
- Q: Would native metrics deliver important details? -> A: They would improve
  scalable aggregation and dashboarding, especially histogram-based p75 trends
  over low-cardinality dimensions such as metric name, route template, device
  class, and environment. They would not replace the detailed span samples:
  session id, exact URL, replay join keys, LCP/INP/CLS attribution selectors,
  and per-sample drilldown are better preserved on spans/records. If metrics
  are added later, keep spans as raw samples or exemplars rather than replacing
  them.
- Q: What is the agreed plan for metrics? -> A: Keep PRP 021 spans-first, then
  add a dedicated native metrics PRP that emits Web Vitals metrics in parallel
  with spans. That follow-up should define metric instrument shape, names,
  units, dimensions, exporter/proxy configuration, lifecycle cleanup, and
  Platform/Perses query behavior.
- Q: Should `rum.webVitals: true` automatically enable default `rum.session`?
  -> A: Yes. Web Vital spans need session/page attribution by default, and the
  opt-in `rum.webVitals` API should make the Platform-compatible path easy.
- Q: What happens for `rum: { session: false, webVitals: true }`? -> A: Reject
  this configuration with a clear runtime error. Explicitly disabling session
  conflicts with the chosen Web Vitals RUM contract.
- Q: Is `web-vitals` acceptable as a direct `@pydantic/logfire-browser`
  dependency? -> A: Yes. Add it as a direct dependency pinned through the
  workspace catalog, but dynamically import `web-vitals/attribution` only when
  `rum.webVitals` is enabled.
- Q: Should the SDK emit the modern LCP attribution field or the Platform POC
  alias? -> A: Emit both `web_vital.lcp.target` and `web_vital.lcp.element`,
  deriving both from the v5 `attribution.target` field for compatibility.
- Q: How should this first pass handle modern SPAs? -> A: Treat standard Web
  Vitals as document-level browser lifecycle measurements and document that this
  PRP does not add per-route soft-navigation Core Web Vitals.

## Unknowns & Risks

- The exact Platform UI query contract for attribution field names may evolve.
  Emitting both modern `web_vital.lcp.target` and compatibility
  `web_vital.lcp.element` reduces short-term migration risk.
- Dynamic import behavior needs verification in both ESM and CJS bundle outputs.
- Because `web-vitals` observers cannot be unregistered, test helpers must not
  imply production cleanup can remove page-lifetime observers.
- Web Vitals callbacks are browser lifecycle-dependent, so package tests should
  mock callbacks rather than rely on real PerformanceObserver behavior.
- If `rum.webVitals` implies session identity, it broadens the attributes on
  all browser spans when Web Vitals is enabled. This is still opt-in, but should
  be explicit in docs.
- The native metrics follow-up should not remove or weaken Web Vital spans;
  spans are still needed for raw sample drilldown and replay/session
  correlation.

**Confidence: 8/10** for one-pass implementation success after the clarification
questions are settled.
