---
title: Browser performance
description: Measure page loads, Web Vitals, and main-thread congestion in browser applications.
---

# Browser performance

`configureFrontend()` enables Web Vitals by default. Long Animation Frame
reporting is opt-in. Use the [Frontend page](https://pydantic.dev/docs/logfire/observe/frontend/)
to investigate the collected data.

The examples use `frontendOptions` from the [browser setup](../browser.md#configure).
Add these options to your application's existing `configureFrontend()` call.

## Web Vitals

`configureFrontend()` records Core Web Vitals from real browser sessions by default:

```ts
logfire.configureFrontend({
  ...frontendOptions,
  rum: { webVitals: true },
})
```

The browser SDK dynamically loads `web-vitals/attribution` only when
`rum.webVitals` is enabled. It records LCP, INP, CLS, FCP, and TTFB as short
OpenTelemetry spans named `web_vital.lcp`, `web_vital.inp`, `web_vital.cls`,
`web_vital.fcp`, and `web_vital.ttfb`. These point events carry exact
`logfire.span_type = 'log'`.

### Captured attributes

Every Web Vital span includes `web_vital.name`, `web_vital.value`,
`web_vital.delta`, `web_vital.id`, `web_vital.rating`, and
`web_vital.navigation_type`. It also includes available navigation identity,
interaction, and start-time fields as `web_vital.navigation_*`. Attribution fields include values such as
`web_vital.lcp.target`, `web_vital.inp.target`, and
`web_vital.cls.largest_shift_target`.
When INP attribution identifies a culprit Long Animation Frame script, the INP
span also includes its normalized source URL, bounded function name, invoker,
and duration as `web_vital.inp.script.*` attributes. These diagnostic fields
remain span-only and are not added to Web Vitals metrics.

`rum.webVitals` implies default `rum.session` behavior so Web Vital spans get
session and URL attributes. To sanitize URLs while reporting Web Vitals, pass
session options alongside Web Vitals:

```ts
logfire.configureFrontend({
  ...frontendOptions,
  rum: {
    session: {
      urlAttributes: (url) => ({
        full: `${url.origin}${url.pathname}`,
        path: url.pathname,
      }),
    },
    webVitals: {
      reportAllChanges: true,
    },
  },
})
```

### Observer options

Web Vitals observers live for the page lifetime. The first successful startup
fixes `reportAllChanges`, `generateTarget`,
`includeProcessedEventEntries`, and `reportSoftNavs`; later `configure()` calls can update the tracer
and metric destination but ignore changed observer options with a diagnostic
warning. If the initial lazy load or observer startup fails, a later
`configure()` call retries it.

### Metrics

`configureFrontend()` enables Web Vitals histogram metrics by default. To keep
Web Vitals spans while disabling histogram emission:

```ts
logfire.configureFrontend({
  ...frontendOptions,
  rum: {
    webVitals: {
      metrics: false,
    },
  },
})
```

`configureFrontend()` derives the metrics endpoint from `baseUrl` automatically.
With the lower-level `configure()`, metric export is disabled unless top-level
`metrics.metricUrl` is configured, and `rum.webVitals.metrics` requires that
transport. The SDK uses a local
OpenTelemetry `MeterProvider`; it does not replace the application's global
meter provider. If that metrics runtime fails to start, the SDK emits an
explicit diagnostic and continues Web Vitals span reporting without a metric
recorder. It never retries configured authentication with empty headers.

Web Vitals metrics are histograms named
`logfire.browser.web_vital.lcp`, `logfire.browser.web_vital.inp`,
`logfire.browser.web_vital.cls`, `logfire.browser.web_vital.fcp`, and
`logfire.browser.web_vital.ttfb`. LCP, INP, FCP, and TTFB use unit `ms`; CLS
uses unit `1`.

Metric data point attributes are intentionally low-cardinality:
`web_vital.name` and `web_vital.rating` by default. When soft-navigation
reporting is enabled, they also include `web_vital.navigation_type`. They do not include
`session.id`, `logfire.page.url.full`, `logfire.page.url.path`,
`logfire.page.route`, `logfire.session.*`, Web Vital
ids/deltas, DOM selectors, attribution fields, or raw PerformanceEntry data. Use
spans for raw-sample drilldown, session/replay correlation, exact page context,
and attribution selectors. When metrics are configured, Logfire Platform should
treat these histograms as the aggregate Web Vitals surface.

### Single-page app navigation

By default, Web Vitals use the standard document-level measurement method. Web
Vital span URL attributes describe the navigation that produced the measurement,
even when its callback runs after the browser URL changes. The span's
`logfire.page.route` is the route of that same navigation. The SDK remembers the
first route that `getRouteName` returned while each navigation's URL was
current, and it uses that route for a late report, even after the application
changes its route state or returns to the same URL. If the SDK never observed a
route for that navigation, the span omits `logfire.page.route` instead of using
the current route. If the browser does not supply a valid navigation URL for a
document report, the span falls back to the current sanitized URL and route.

Chromium 151 and newer can also report metrics separately for browser-detected
soft navigations in single-page applications:

```ts
logfire.configureFrontend({
  ...frontendOptions,
  rum: {
    webVitals: {
      reportSoftNavs: true,
    },
  },
})
```

This option remains document-level in Firefox, Safari, and older Chromium. A
soft navigation requires a user interaction, URL change, and resulting paint,
so browser detection can differ from application router events. Enabling it
also finalizes the initial navigation when the first soft navigation occurs.
Soft-navigation LCP considers newly painted content, which can differ from a
cold load of the same URL, and soft-navigation TTFB is reported as `0` rather
than as request latency.

Soft-navigation spans use the metric's sanitized navigation URL. They carry
`logfire.page.route` when the SDK observed a route for that navigation, and omit
it otherwise. Web Vitals metrics do not carry the route. To add a
low-cardinality route dimension to metrics, derive it from the metric's
`navigationURL` in `rum.webVitals.metrics.attributes`.

## Long Animation Frames

Enable `rum.longAnimationFrames` to detect and diagnose severe main-thread
congestion in supported Chromium browsers:

```ts
logfire.configureFrontend({
  ...frontendOptions,
  rum: {
    longAnimationFrames: true,
  },
})
```

The Long Animation Frames API observes frames over 50 ms. It is available in
Chromium-based browsers, but not in Firefox or Safari at the time of writing.
It does not cover all main-thread work and cannot attribute cross-origin
frames, workers, or extension isolated worlds. Treat it as a high-coverage
sentinel for severe congestion, complementary to INP, request volume, journey
timing, and synthetic monitoring.

The feature is off by default. When enabled, the SDK feature-detects
`long-animation-frame`, samples 10% of browser sessions, and observes with
`buffered: true`. Sampled-out and unsupported sessions do not install an
observer, timer, or lifecycle listeners.

For sampled sessions, the SDK emits two log-type span shapes:

- `browser.long_animation_frame` diagnoses frames whose `blockingDuration` is
  at least 100 ms. Frames are ranked within each foreground window, and the
  worst frames are emitted up to a fixed cap of 20 per browser session.
- `browser.main_thread_window` summarizes each foreground window with its real
  foreground duration, total blocking duration, LoAF count, dropped diagnostic
  count, and the top three scripts by summed duration. Hidden time is excluded,
  and a partial window is emitted on document hide or `pagehide`.

The default ranking and summary window is 60 seconds. You can tune collection
without changing the SDK-owned event and script caps:

```ts
logfire.configureFrontend({
  ...frontendOptions,
  rum: {
    longAnimationFrames: {
      blockingDurationThresholdMs: 150,
      sessionSampleRate: 0.25,
      windowDurationMs: 30_000,
    },
  },
})
```

`sessionSampleRate` is clamped to `0..1`. The window has a 10-second minimum to
prevent accidental span floods. HTTP(S) script source URLs have credentials,
query strings, and fragments removed and are capped at 2,048 Unicode code
points. Payload-bearing and per-load URL schemes use stable scheme or origin
placeholders. Function names are capped at 200 Unicode code points. Periodic
window summaries do not extend the browser session idle timeout, but diagnostic
frame spans count as session activity. LoAF data is emitted only as spans, never
as OpenTelemetry metrics. The existing browser session processor adds session
id, route, sanitized page URL, replay state, and service-version context to both
span shapes.

## Resource timing detail

Use compact resource timing to keep the `documentLoad`, `documentFetch`, and
per-asset `resourceFetch` spans while omitting their DNS, connection, TLS,
request, response, and DOM timing events:

```ts
logfire.configureFrontend({
  ...frontendOptions,
  resourceTiming: { detail: 'summary' },
})
```

`summary` is the default when `resourceTiming` is configured, so
`resourceTiming: {}` is equivalent. Use `detail: 'full'` when you need the
phase events for detailed diagnostics. Full detail increases telemetry volume,
especially on pages with many static assets.

`resourceTiming` controls only the document-load instrumentation created by
`autoInstrumentations`; it does not enable auto-instrumentation or override an
explicitly disabled document-load instrumentation. When the raw
`@opentelemetry/instrumentation-document-load.ignoreNetworkEvents` option is
also present, `resourceTiming.detail` takes precedence. Other raw document-load
options remain unchanged. Summary mode does not remove `firstPaint` or
`firstContentfulPaint`; use the upstream `ignorePerformancePaintEvents` option
if you also want to omit paint events.
