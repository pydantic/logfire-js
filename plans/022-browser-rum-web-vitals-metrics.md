# Browser RUM Web Vitals Native Metrics

## Goal

Add opt-in native OpenTelemetry metric export for browser Web Vitals in
`@pydantic/logfire-browser`, emitted in parallel with the `web_vital.*` spans
from PRP 021.

The end state is:

- Browser `configure()` can set up an SDK-owned OpenTelemetry `MeterProvider`
  and OTLP HTTP metric exporter for browser-safe proxy URLs.
- `rum.webVitals` can record LCP, INP, CLS, FCP, and TTFB as histogram metrics
  while continuing to emit the PRP 021 spans.
- Metric export is disabled unless explicitly configured.
- Metric data points use low-cardinality dimensions suitable for p75 dashboard
  queries.
- Web Vital spans remain the raw-sample drilldown path for session ids, exact
  URLs, replay correlation, and attribution selectors.

This PRP deliberately does not add session replay, Platform UI migration,
automatic route-template extraction, or per-route soft-navigation Web Vitals.

## Why

- PRP 021 gives Platform-compatible spans and raw Web Vital samples, but metrics
  are the better long-term data model for p75 dashboards and time-series
  aggregation.
- Platform already has a browser OTLP metrics proxy endpoint at
  `/v1/metrics/browser`, but the SDK does not yet produce browser metrics.
- Native histograms let Platform/Perses query p75 trends without scanning raw
  trace records for every dashboard render.
- Keeping spans in parallel preserves the details that should not become metric
  dimensions: session id, exact URL, replay join keys, LCP/INP/CLS attribution
  selectors, and per-sample debugging context.

## Success Criteria

- [x] `@pydantic/logfire-browser` has deliberate direct dependencies for
      browser metrics: `@opentelemetry/sdk-metrics` and
      `@opentelemetry/exporter-metrics-otlp-http`, both pinned through the
      workspace catalog.
- [x] `LogfireConfigOptions` exposes browser metric exporter configuration
      without enabling metrics by default.
- [x] `configure()` creates a browser `MeterProvider` only when metrics are
      configured.
- [x] `configure()` does not call `metrics.setGlobalMeterProvider()` or replace
      a user application's global meter provider.
- [x] `configure()` wires metric cleanup into the existing memoized cleanup
      lifecycle with force-flush and shutdown.
- [x] `rum.webVitals` can opt into metric recording while preserving the PRP 021
      span emission.
- [x] Web Vitals are recorded as histograms with stable names, units, and bucket
      boundaries.
- [x] Metric data point attributes are low cardinality and do not include
      `session.id`, `browser.session.id`, `url.full`, DOM selectors, or
      PerformanceEntry data.
- [x] If Web Vitals metrics are requested without a metric exporter/readers,
      the SDK throws a clear configuration error.
- [x] Browser README/docs and the browser smoke example document the metric
      proxy URL and the spans-plus-metrics behavior.

## Context

### Key Files

- `packages/logfire-browser/src/index.ts` - owns `configure()`, resource
  creation, browser tracer provider setup, cleanup lifecycle, and PRP 021
  `rum.webVitals` startup.
- `packages/logfire-browser/src/webVitals.ts` - owns Web Vitals callback
  registration and span attribute mapping. This PRP should extend it to fan out
  to metric recording without registering `web-vitals` callbacks twice.
- `packages/logfire-browser/src/browserSession.ts` - currently owns `RUMOptions`
  and `BrowserWebVitalsOptions` references. Add Web Vitals metric option types
  here or move broader RUM types into a new module if ownership becomes clearer.
- `packages/logfire-browser/src/index.test.ts` - configure-level tests for
  provider creation, cleanup ordering, and config validation.
- `packages/logfire-browser/src/webVitals.test.ts` - tests for Web Vital
  callback registration and metric recording from mocked `web-vitals`
  callbacks.
- `packages/logfire-browser/package.json` - add direct metric SDK/exporter
  dependencies.
- `pnpm-workspace.yaml` and `pnpm-lock.yaml` - add/update catalog and lockfile
  entries for `@opentelemetry/exporter-metrics-otlp-http`.
- `packages/logfire-browser/README.md` and `docs/packages/browser.md` -
  document browser metrics setup, proxy URL, and metric names.
- `examples/browser/src/main.ts`, `examples/browser/README.md`, and
  `examples/browser/src/proxy.ts` - extend the smoke example to optionally
  proxy `/client-metrics` or `/v1/metrics` and show the user-facing test path.
- `packages/logfire-node/src/metricExporter.ts` - Node metric exporter pattern
  using `PeriodicExportingMetricReader`, useful for lifecycle and option
  naming, but do not copy the Node-only `exporter-metrics-otlp-proto` package
  into browser code.
- `packages/logfire-node/src/sdk.ts` - Node runtime cleanup pattern for
  force-flushing and shutting down metric readers.
- `../platform/src/services/logfire-backend/logfire_backend/routes/v1/metrics.py`
  - Platform browser metrics endpoint accepts OTLP metrics as protobuf or JSON
    at `/v1/metrics/browser`.
- `../platform/src/services/logfire-backend/logfire_backend/services/browser_telemetry.py`
  - Platform forwards browser metrics and overwrites protected resource/data
    point attributes such as `service.name` and authenticated user fields.
- `../platform/src/services/logfire-frontend/src/app/rum/rum-queries.ts` -
  current RUM UI still queries Web Vitals from `records`, so SDK metrics must
  be additive rather than replacing spans.
- `docs/rum-session-replay-prp-roadmap.md` - umbrella roadmap. This PRP becomes
  022 and shifts replay PRPs to 023/024.

### External References

- https://github.com/open-telemetry/opentelemetry-js/tree/main/packages/sdk-metrics
  - JS Metrics SDK package. `MeterProvider` accepts `readers`; `forceFlush()`
    and `shutdown()` are lifecycle methods.
- https://github.com/open-telemetry/opentelemetry-js/tree/main/experimental/packages/opentelemetry-exporter-metrics-otlp-http
  - OTLP HTTP metrics exporter package for web and node. Browser exporter
    expects an endpoint ending in `/v1/metrics`.
- https://opentelemetry.io/docs/specs/otel/metrics/api/
  - Metric instrument semantics. Histograms record raw non-negative
    measurements for downstream aggregation.
- https://opentelemetry.io/docs/specs/otel/metrics/sdk/
  - Metric SDK concepts: MeterProvider, readers, views, aggregation, export.
- https://web.dev/articles/vitals
  - Web Vitals definitions and thresholds. Use thresholds to inform default
    histogram bucket boundaries.

### Gotchas

- Do not use `@opentelemetry/exporter-metrics-otlp-proto` in the browser
  package. The browser-compatible package is
  `@opentelemetry/exporter-metrics-otlp-http`.
- The OTLP HTTP metric exporter sends JSON over HTTP. Platform's
  `/v1/metrics/browser` accepts JSON and protobuf, then forwards protobuf
  internally.
- Web Vitals callbacks cannot be unregistered and should not be registered more
  than once per page lifecycle. Metric recording must reuse PRP 021 callback
  registration rather than calling `onLCP()`, `onINP()`, etc. again.
- The current `startBrowserWebVitals()` implementation is guarded by a
  module-level startup promise. If a page first configures Web Vitals without
  metrics and later reconfigures with metrics, later metric enablement cannot
  add new observers. Either reject this transition clearly or design the module
  to register sinks before first startup and keep later cleanup no-op.
- Browser metrics should use a local `MeterProvider`. Do not set the global
  OpenTelemetry meter provider from `@pydantic/logfire-browser` unless a future
  explicit option asks for that. Replacing the global provider can break app
  instrumentation.
- Metric dimensions must stay low-cardinality. Do not put session ids, exact
  full URLs, DOM selectors, interaction targets, replay ids, or raw attribution
  values on metric data points.
- `url.path` is useful but can still be high-cardinality for apps with IDs in
  paths. Provide an attribute customization/sanitization path and document that
  route templates are preferred when available.
- CLS is dimensionless and should not share a millisecond metric instrument
  with LCP/INP/FCP/TTFB.
- Browser metric export needs a separate backend proxy URL from traces in many
  deployments. Do not silently derive a metrics URL from `traceUrl` unless this
  is explicitly accepted in clarification.
- Metric export interval affects battery/network usage. Use conservative
  defaults and allow configuration.

## Implementation Blueprint

### Data Models

Recommended top-level metric transport options:

```ts
import type { OTLPMetricExporterOptions } from '@opentelemetry/exporter-metrics-otlp-http'
import type { MetricReader, PeriodicExportingMetricReaderOptions } from '@opentelemetry/sdk-metrics'

export interface BrowserMetricsOptions {
  /**
   * Browser-safe OTLP metrics proxy URL, e.g. `/logfire-proxy/v1/metrics`
   * for generic apps or `/v1/metrics/browser` inside Platform.
   */
  metricUrl: string
  /**
   * Static or dynamic headers for the metric exporter.
   * Browser apps should normally authenticate through their backend proxy,
   * not with a Logfire write token in client code.
   */
  metricExporterHeaders?: () => Record<string, string>
  /**
   * Additional OTLP metric exporter options, excluding url/headers if the
   * implementation chooses to own those fields.
   */
  metricExporterConfig?: Omit<OTLPMetricExporterOptions, 'url' | 'headers'>
  /**
   * Periodic reader settings such as exportIntervalMillis and
   * exportTimeoutMillis. Defaults should be conservative for browsers.
   */
  metricReaderConfig?: Omit<PeriodicExportingMetricReaderOptions, 'exporter'>
  /**
   * Advanced extension point for callers that already own a metric reader.
   */
  metricReaders?: MetricReader[]
}
```

Recommended RUM/Web Vitals option extension:

```ts
export interface BrowserWebVitalsMetricOptions {
  /**
   * Add sanitized data point attributes. Keep this low-cardinality.
   */
  attributes?: false | ((metric: MetricWithAttribution) => Attributes)
}

export interface BrowserWebVitalsOptions {
  reportAllChanges?: boolean
  generateTarget?: (element: Node | null) => string | undefined
  includeProcessedEventEntries?: boolean
  /**
   * Emit native OTel metrics in parallel with spans. Requires configured
   * browser metrics transport.
   */
  metrics?: boolean | BrowserWebVitalsMetricOptions
}

export interface RUMOptions {
  session?: boolean | BrowserSessionOptions
  webVitals?: boolean | BrowserWebVitalsOptions
}
```

Recommended histogram instruments:

```ts
interface WebVitalMetricInstrument {
  name: string
  unit: 'ms' | '1'
  description: string
  boundaries: number[]
}
```

Metric names and units:

- `logfire.browser.web_vital.lcp` - histogram, unit `ms`
- `logfire.browser.web_vital.inp` - histogram, unit `ms`
- `logfire.browser.web_vital.fcp` - histogram, unit `ms`
- `logfire.browser.web_vital.ttfb` - histogram, unit `ms`
- `logfire.browser.web_vital.cls` - histogram, unit `1`

Recommended default bucket boundaries:

- LCP ms: `[500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 5000, 8000, 10000]`
- INP ms: `[50, 100, 150, 200, 300, 500, 800, 1000, 2000]`
- FCP ms: `[500, 1000, 1500, 1800, 2500, 3000, 4000, 6000]`
- TTFB ms: `[100, 300, 500, 800, 1200, 1800, 2500, 4000]`
- CLS score: `[0.01, 0.05, 0.1, 0.15, 0.25, 0.5, 1]`

Recommended default metric data point attributes:

- `web_vital.name`
- `web_vital.rating`
- `url.path` only if available from the configured browser session URL
  sanitizer and only if the user has not disabled URL attributes

Explicitly excluded from metric data points:

- `session.id`
- `browser.session.id`
- `url.full`
- `web_vital.id`
- `web_vital.delta`
- attribution selectors/targets
- `PerformanceEntry` objects or arrays

### Tasks

```yaml
Task 1: Add Browser Metric Dependencies
  MODIFY pnpm-workspace.yaml:
    - Add `@opentelemetry/exporter-metrics-otlp-http` to the catalog using the
      same version range family as other experimental OTel exporters.
    - Reuse existing `@opentelemetry/sdk-metrics` catalog entry.
  MODIFY packages/logfire-browser/package.json:
    - Add `@opentelemetry/sdk-metrics: catalog:`.
    - Add `@opentelemetry/exporter-metrics-otlp-http: catalog:`.
  UPDATE pnpm-lock.yaml:
    - Run the repo dependency install/update command after metadata changes.

Task 2: Add Browser Metrics Provider Module
  CREATE packages/logfire-browser/src/browserMetrics.ts:
    - Define BrowserMetricsOptions and a BrowserMetricsRuntime/Handle type.
    - Dynamically import `@opentelemetry/sdk-metrics` and
      `@opentelemetry/exporter-metrics-otlp-http` only when metrics are
      configured, unless static imports are needed for public types.
    - Build `OTLPMetricExporter` with `metricUrl`, optional dynamic headers,
      and optional exporter config.
    - Build `PeriodicExportingMetricReader` with conservative defaults and
      optional reader config.
    - Build a local `MeterProvider({ resource, readers })`.
    - Expose `getMeter()` or prepared Web Vitals histogram instruments to
      `webVitals.ts`.
    - Implement idempotent forceFlush/shutdown behavior with diag logging.
  PATTERN:
    - packages/logfire-node/src/metricExporter.ts
    - packages/logfire-node/src/sdk.ts

Task 3: Extend Browser Configure API
  MODIFY packages/logfire-browser/src/index.ts:
    - Add `metrics?: false | BrowserMetricsOptions` to LogfireConfigOptions.
    - Resolve metric transport before starting Web Vitals.
    - Create the metric runtime only when metrics are configured.
    - Do not create a MeterProvider when metrics are omitted or false.
    - Do not call global `metrics.setGlobalMeterProvider()`.
    - If `rum.webVitals.metrics` is enabled without configured metrics, throw a
      clear configuration error.
    - Add metric runtime cleanup to the memoized cleanup lifecycle.
  GOTCHA:
    - Keep trace behavior unchanged when metrics are omitted.

Task 4: Add Web Vitals Metric Recording
  MODIFY packages/logfire-browser/src/webVitals.ts:
    - Add optional metric sink/recorder to Web Vitals startup.
    - Record each Web Vital callback to the matching histogram.
    - Keep the existing span emission unchanged.
    - Reuse one `web-vitals/attribution` registration.
    - Add a no-op inactive state after cleanup so late Web Vitals callbacks do
      not throw after metric shutdown.
    - Ensure callback errors are reported through `diag.error` and do not throw
      into page code.
  DECISION:
    - Use one histogram per Web Vital to avoid mixed units.

Task 5: Add Tests
  MODIFY packages/logfire-browser/src/index.test.ts:
    - Assert metrics omitted/false creates no MeterProvider or metric exporter.
    - Assert metric config creates a MeterProvider after resource creation.
    - Assert dynamic headers are resolved by the metric exporter.
    - Assert cleanup force-flushes/shuts down metrics exactly once and remains
      memoized.
    - Assert `rum.webVitals.metrics` without metric transport throws.
    - Assert the browser session processor still exists when Web Vitals imply
      session.
  MODIFY packages/logfire-browser/src/webVitals.test.ts:
    - Mock metric recorder/histograms.
    - Assert LCP/INP/FCP/TTFB record to ms histograms and CLS records to the
      dimensionless histogram.
    - Assert only low-cardinality attributes are recorded.
    - Assert session id, browser session id, url.full, web_vital.id,
      web_vital.delta, and attribution selectors are not metric attributes.
    - Assert spans still emit the full PRP 021 attributes.
    - Assert duplicate starts do not duplicate `web-vitals` observers or metric
      recordings.
  OPTIONAL CREATE packages/logfire-browser/src/browserMetrics.test.ts:
    - Unit test metric runtime option resolution and cleanup if this logic is
      large enough to stand alone.

Task 6: Update Docs and Smoke Example
  MODIFY packages/logfire-browser/README.md:
    - Document `metrics.metricUrl`.
    - Show `rum.webVitals: { metrics: true }` with a browser-safe proxy.
    - Explain that metrics are histograms for aggregate dashboards and spans are
      retained for drilldown.
    - Explain metric names, units, and omitted high-cardinality attributes.
  MODIFY docs/packages/browser.md:
    - Add the docs-site version of the same guidance.
  MODIFY examples/browser/src/proxy.ts:
    - Add a `/client-metrics` proxy path if the example keeps local Express
      proxying.
  MODIFY examples/browser/src/main.ts and examples/browser/README.md:
    - Add commented or enabled metric smoke config depending on whether a local
      metrics proxy can be run without additional setup.

Task 7: Add Release Note
  CREATE .changeset/[generated-name].md:
    - Add a minor changeset for `@pydantic/logfire-browser`.
    - Mention opt-in Web Vitals native metrics emitted in parallel with spans.
```

### Integration Points

```yaml
CONFIG:
  - packages/logfire-browser/src/index.ts
    Add browser metric transport config and validate Web Vitals metrics require
    that transport.

METRIC PROVIDER:
  - packages/logfire-browser/src/browserMetrics.ts
    Own MeterProvider, OTLP HTTP exporter, reader, histogram instruments, and
    cleanup.

WEB VITALS:
  - packages/logfire-browser/src/webVitals.ts
    Reuse the existing callback path and record metrics in parallel with spans.

PACKAGE METADATA:
  - pnpm-workspace.yaml
  - pnpm-lock.yaml
  - packages/logfire-browser/package.json

DOCS / EXAMPLE:
  - packages/logfire-browser/README.md
  - docs/packages/browser.md
  - examples/browser/*
```

No backend, database, Platform frontend, replay package, or release/publish
work is part of this PRP.

## Validation

Run these from the repository root:

```bash
vp run @pydantic/logfire-browser#test
vp run @pydantic/logfire-browser#typecheck
vp run @pydantic/logfire-browser#build
vp run @pydantic/logfire-browser#lint
vp fmt --check
git diff --check
```

For dependency/lockfile and broader confidence before PR:

```bash
vp install --no-frozen-lockfile
vp check
vp run --filter "./packages/*" build
vp run --filter "./packages/*" typecheck
vp run --filter "./packages/*" test
```

If this environment's `pnpm` shim reports Node `v24.14.0` while the repo
requires `>=24.14.1`, prefer the direct `vp` commands above and note the
environment issue in the execution summary.

### Required Test Coverage

- [x] Metrics omitted: no metric SDK/exporter startup.
- [x] `metrics: false`: no metric SDK/exporter startup.
- [x] Metrics configured: MeterProvider, PeriodicExportingMetricReader, and
      OTLPMetricExporter are created with the expected URL and options.
- [x] Dynamic metric headers are used by the exporter.
- [x] Cleanup force-flushes/shuts down metrics once and remains memoized.
- [x] `rum.webVitals.metrics: true` without metric transport throws clearly.
- [x] LCP, INP, FCP, and TTFB record millisecond histogram values.
- [x] CLS records dimensionless histogram values.
- [x] Metric attributes are low-cardinality and exclude session/exact
      URL/selector/raw entry attributes.
- [x] Existing Web Vital spans still include PRP 021 attributes.
- [x] Duplicate Web Vitals startup does not duplicate observers or metric
      records.
- [x] Browser example builds after metric config/docs changes.

## Clarifications

### Session 2026-06-29

- Q: Should browser metric transport be a top-level `metrics` config shared by
  future browser metrics, or nested under `rum.webVitals.metrics` for this
  feature only? -> A: Use top-level `metrics` transport config, with
  `rum.webVitals.metrics` controlling whether Web Vitals record native metrics.
  This keeps metric export reusable for future browser metrics without making
  all Web Vitals users configure native metrics.
- Q: Should the SDK require an explicit `metricUrl`, or infer it from
  `traceUrl` by replacing `/traces` with `/metrics`? -> A: Require explicit
  `metricUrl`. Browser metrics often need a different proxy route, and silent
  inference can export to the wrong endpoint.
- Q: Should `url.path` be included as a default Web Vitals metric dimension?
  -> A: Yes when session URL attributes are enabled and available. Document
  route templates/sanitized paths and allow suppression/customization to manage
  cardinality.
- Q: Should metric histograms use the proposed
  `logfire.browser.web_vital.*` names, or align to a Platform/Perses naming
  convention first? -> A: Use the proposed names unless Platform provides a
  concrete alternative before execution.
- Q: Should the example enable metrics by default, or document metrics as an
  optional smoke path requiring a metrics proxy? -> A: Extend the browser smoke
  proxy/example in this PRP so user-perspective metric testing is possible.
- Q: What happens if Web Vitals were already started without metrics and a
  later configure call tries to enable Web Vitals metrics in the same page
  lifecycle? -> A: Reject this transition clearly. Web Vitals observers are
  page-lifetime callbacks and should not be re-registered.
- Q: What metric instrument shape should be used? -> A: Use one histogram per
  Web Vital, with unit `ms` for LCP, INP, FCP, and TTFB, and unit `1` for CLS.

## Unknowns & Risks

- Platform/Perses query conventions for browser Web Vitals metrics are not yet
  settled. Use the proposed names unless Platform provides a concrete
  alternative before execution.
- The public API boundary is settled for this PRP: top-level `metrics`
  transport plus nested `rum.webVitals.metrics` enablement. Future browser
  metrics should reuse the top-level transport.
- Exact browser bundle size impact of `@opentelemetry/sdk-metrics` and
  `@opentelemetry/exporter-metrics-otlp-http` should be checked. Dynamic import
  should keep baseline trace-only usage from loading metric code.
- `url.path` as a metric dimension can create high cardinality for apps with IDs
  in paths. This is useful for RUM dashboards but needs a suppression or route
  template path.
- Web Vitals observers are page-lifetime callbacks. Late callbacks after metric
  provider shutdown must no-op rather than throw.
- If the app already uses OpenTelemetry metrics globally, a local MeterProvider
  avoids clobbering it but also means Logfire's Web Vitals metrics are isolated
  from the app's global metric pipeline.

**Confidence: 7/10** for one-pass implementation success after clarification.
