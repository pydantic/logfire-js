# Pydantic Logfire — JavaScript SDK

From the team behind [Pydantic Validation](https://pydantic.dev/), **Pydantic Logfire** is an observability platform built on the same belief as our open source library — that the most powerful tools can be easy to use.

What sets Logfire apart:

- **Simple and Powerful:** Logfire's dashboard is simple relative to the power it provides, ensuring your entire engineering team will actually use it.
- **SQL:** Query your data using standard SQL — all the control and (for many) nothing new to learn. Using SQL also means you can query your data with existing BI tools and database querying libraries.
- **OpenTelemetry:** Logfire is an opinionated wrapper around OpenTelemetry, allowing you to leverage existing tooling, infrastructure, and instrumentation for many common packages, and enabling support for virtually any language.

See the [documentation](https://logfire.pydantic.dev/docs/) for more information.

**Feel free to report issues and ask any questions about Logfire in this repository!**

This repo contains the JavaScript Browser SDK; the server application for recording and displaying data is closed source.

If you need to instrument your Node.js application, see the [`logfire` package](https://www.npmjs.com/package/logfire).
If you're instrumenting Cloudflare, see the [Logfire CF workers package](https://www.npmjs.com/package/@pydantic/logfire-cf-workers).

## Basic usage

See the [Logfire Browser docs for a primer](https://logfire.pydantic.dev/docs/integrations/javascript/browser/). Ready to run examples are available in the repository [in vanilla browser](https://github.com/pydantic/logfire-js/tree/main/examples/browser) and [Next.js variants](https://github.com/pydantic/logfire-js/tree/main/examples/nextjs-client-side-instrumentation).

## Managed Variables

Browser applications can use local managed variables from `logfire/vars` when
the app already depends on the core `logfire` package. Do not configure the
remote provider in browser bundles because it requires a Logfire API key.

## Resource attributes

Use `resourceAttributes` for stable browser application or session metadata that
should be attached to all telemetry from the configured provider:

```js
import * as logfire from '@pydantic/logfire-browser'

logfire.configure({
  traceUrl: '/client-traces',
  serviceName: 'browser-app',
  resourceAttributes: {
    'service.namespace': 'my-company',
    'app.installation.id': installationId,
  },
})
```

Do not use resource attributes for per-request values or sensitive user data.
First-class options such as `serviceName`, `serviceVersion`, and `environment`
take precedence over conflicting `resourceAttributes` keys.

## RUM session identity

Enable `rum.session` to add a browser session id to every span started by the
configured browser provider:

```js
import * as logfire from '@pydantic/logfire-browser'

logfire.configure({
  traceUrl: '/client-traces',
  serviceName: 'browser-app',
  rum: { session: true },
})
```

The SDK stores the session in `sessionStorage`, so it is scoped to the browser
tab and survives page reloads. Sessions rotate after 30 minutes of inactivity
or 4 hours of total duration by default. Spans get `session.id` and
`browser.session.id`; `session.id` is the OpenTelemetry semantic attribute and
`browser.session.id` is emitted for Logfire Platform compatibility.

By default, session-enabled spans also get `logfire.page.url.full` and
`logfire.page.url.path` from the current page URL. During the alpha, the SDK
also emits compatibility `url.full` and `url.path` values with the same
sanitized page URL. Prefer `logfire.page.url.*` for page grouping because
OpenTelemetry fetch/resource spans may use `url.*` for the network target URL.
If your app has sensitive query strings or fragments, provide a sanitizer or
suppress URL attributes:

```js
logfire.configure({
  traceUrl: '/client-traces',
  serviceName: 'browser-app',
  rum: {
    session: {
      urlAttributes: (url) => ({
        full: `${url.origin}${url.pathname}`,
        path: url.pathname,
      }),
    },
  },
})

logfire.configure({
  traceUrl: '/client-traces',
  serviceName: 'browser-app',
  rum: {
    session: {
      urlAttributes: false,
    },
  },
})
```

Use `getBrowserSessionId()` after `configure({ rum: { session: true } })` when
another browser integration needs the SDK-owned session id before the first
span is created.

## RUM Web Vitals

Enable `rum.webVitals` to report Core Web Vitals from real browser sessions:

```js
import * as logfire from '@pydantic/logfire-browser'

logfire.configure({
  traceUrl: '/client-traces',
  serviceName: 'browser-app',
  rum: { webVitals: true },
})
```

The SDK dynamically loads `web-vitals/attribution` only when `rum.webVitals` is
enabled. It records LCP, INP, CLS, FCP, and TTFB as short spans named
`web_vital.lcp`, `web_vital.inp`, `web_vital.cls`, `web_vital.fcp`, and
`web_vital.ttfb`.

Each span includes base attributes such as `web_vital.name`,
`web_vital.value`, `web_vital.delta`, `web_vital.id`, `web_vital.rating`, and
`web_vital.navigation_type`. Attribution fields include values such as
`web_vital.lcp.target`, `web_vital.inp.target`, and
`web_vital.cls.largest_shift_target`.

`rum.webVitals` implies default `rum.session` behavior so Web Vital spans get
session and URL attributes. If you need to sanitize URLs, pass session options
alongside Web Vitals:

```js
logfire.configure({
  traceUrl: '/client-traces',
  serviceName: 'browser-app',
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

To emit native OpenTelemetry histogram metrics in parallel with those spans,
configure a browser-safe metrics proxy and opt Web Vitals into metrics:

```js
logfire.configure({
  traceUrl: '/client-traces',
  metrics: {
    metricUrl: '/client-metrics',
  },
  serviceName: 'browser-app',
  rum: {
    webVitals: {
      metrics: true,
    },
  },
})
```

Metric export is disabled unless top-level `metrics.metricUrl` is configured,
and `rum.webVitals.metrics` requires that transport. The SDK uses a local
OpenTelemetry `MeterProvider`; it does not replace the application's global
meter provider.

Web Vitals metrics are histograms named
`logfire.browser.web_vital.lcp`, `logfire.browser.web_vital.inp`,
`logfire.browser.web_vital.cls`, `logfire.browser.web_vital.fcp`, and
`logfire.browser.web_vital.ttfb`. LCP, INP, FCP, and TTFB use unit `ms`; CLS
uses unit `1`.

Metric data point attributes are intentionally low-cardinality:
`web_vital.name` and `web_vital.rating` by default. They do not include
`session.id`, `browser.session.id`, `url.full`, `url.path`, Web Vital
ids/deltas, DOM selectors, attribution fields, or raw PerformanceEntry data. Use
spans for raw-sample drilldown, session/replay correlation, exact page context,
and attribution selectors. When metrics are configured, Logfire Platform should
treat these histograms as the aggregate Web Vitals surface.

For modern single-page apps, these are standard document-level Web Vitals, not
route-level soft-navigation metrics. Span page URL attributes describe the
browser URL when the callback fires; route-specific Core Web Vitals need
separate route or soft-navigation instrumentation. To add a route dimension to metrics, pass a
low-cardinality template such as `/products/:id` through
`rum.webVitals.metrics.attributes`.

## Session replay

Session replay is experimental while Logfire Platform replay ingest and playback
are still behind a feature flag. Keep replay behind your own application flag
and expect minor API, ingest, and UI behavior changes before general
availability.

Install the optional replay package and configure `sessionReplay` when you want
rrweb session recording:

```bash
npm install @pydantic/logfire-session-replay
```

```js
import * as logfire from '@pydantic/logfire-browser'

logfire.configure({
  traceUrl: '/logfire-proxy/v1/traces',
  serviceName: 'browser-app',
  sessionReplay: {
    load: () => import('@pydantic/logfire-session-replay'),
    replayUrl: '/logfire-proxy/v1/replay',
    headers: async () => ({
      'X-CSRF': await getCsrfToken(),
    }),
    maskAllInputs: true,
  },
})
```

`sessionReplay` implies default browser session attributes. Replay chunks and
browser spans share `session.id` / `browser.session.id`. Spans started after
replay has loaded and sampled into `full` or `buffer` mode get
`logfire.session_replay.active` and `logfire.session_replay.mode`. Those active
attributes are truthful best-effort annotations, not the primary correlation
key; early spans should be correlated to replay by browser session id and replay
time bounds. The browser integration intentionally does not poll active trace
context into replay chunks.

Use a backend proxy for browser replay uploads. The proxy should authenticate
the browser request with your application session or CSRF mechanism and add the
Logfire write token server-side. Direct token configuration is available as an
advanced escape hatch:

```js
logfire.configure({
  traceUrl: '/logfire-proxy/v1/traces',
  serviceName: 'browser-app',
  sessionReplay: {
    load: () => import('@pydantic/logfire-session-replay'),
    replayUrl: 'https://logfire-api.pydantic.dev/v1/replay',
    token: '<write-token>',
  },
})
```

Do not use direct tokens in normal browser applications. Replay may capture
console, fetch/XHR, navigation, and DOM events. Keep the default input masking
enabled, use `blockSelector` or `maskTextSelector` for sensitive page regions,
and set `captureConsole`, `captureNetwork`, or `captureNavigation` to `false`
when those side channels are not appropriate.

When testing replay locally, browser privacy extensions or ad blockers may block
requests or dynamic imports whose URLs contain terms such as `session-replay`.
If replay fails to start with `ERR_BLOCKED_BY_CLIENT`, test in a clean profile
or disable the extension for the local app. Vite workspace examples may also
need to load rrweb's browser ESM build (`rrweb/dist/rrweb.js`) rather than its
CommonJS build when importing unpublished workspace output directly.

## Custom span processors

Use `spanProcessors` to register additional OpenTelemetry span processors with
the browser tracer provider:

```js
logfire.configure({
  traceUrl: '/client-traces',
  serviceName: 'browser-app',
  spanProcessors: [customProcessor],
})
```

Custom processors are advanced OpenTelemetry extension points. They are
registered before Logfire's built-in exporting processor and before Logfire
tail sampling, so use them for enrichment or integration hooks rather than
duplicate exporting unless that is intentional.

## Baggage span attributes

Use `baggage.spanAttributes` to copy selected active OpenTelemetry baggage
values onto Logfire manual spans and logs:

```js
import * as logfire from '@pydantic/logfire-browser'

logfire.configure({
  traceUrl: '/client-traces',
  serviceName: 'browser-app',
  baggage: {
    spanAttributes: ['tenant', 'region'],
  },
})
```

Projection is disabled by default and allowlisted. Configured baggage key
`tenant` is emitted as `baggage.tenant`. Explicit span attributes win on
conflict, missing keys are ignored, and values are truncated to 1000
characters. Do not store secrets, credentials, session cookies, raw emails, or
other sensitive user data in baggage because baggage propagates across service
boundaries.

## Minimum level filtering

Use `minLevel` to suppress low-severity manual Logfire telemetry before spans
are created:

```js
import * as logfire from '@pydantic/logfire-browser'

logfire.configure({
  traceUrl: '/client-traces',
  serviceName: 'browser-app',
  minLevel: 'warning',
})
```

Browser configuration does not read Logfire environment variables. Pass
`minLevel` in code, or pass `minLevel: null` to clear a previous setting. Log
helpers and `reportError()` are filtered by their level. Duration-style APIs
such as `span()`, `startSpan()`, `startPendingSpan()`, and `instrument()` are
filtered only when the call or scoped client sets an explicit level.

## Runtime lifecycle

`configure()` returns an async cleanup function. Call it when your application is
tearing down the configured browser provider, such as in tests, previews, or
single-page app shells that replace the whole telemetry setup. Cleanup is
idempotent: repeated or concurrent calls share one promise and run the lifecycle
once in this order:

1. await session replay startup and stop replay when enabled
2. unregister configured instrumentations
3. await Web Vitals startup and shutdown when enabled
4. force-flush and shut down metrics when configured
5. force-flush spans
6. shut down the tracer provider
7. clear SDK-owned browser session state

If any cleanup step fails, Logfire still attempts the later steps before
returning the first failure. Later calls return the same settled cleanup promise
rather than starting another cleanup cycle.

Browser pages also get OpenTelemetry's built-in batch-processor auto-flush on
document hide. The underlying batch span processor calls `forceFlush()` when the
document becomes hidden or emits `pagehide`, which helps export spans during
navigation away from the page. You can disable that OpenTelemetry behavior with
`batchSpanProcessorConfig.disableAutoFlushOnDocumentHide`, but doing so means
only explicit cleanup or normal batch timing will flush spans.

## Pending spans

Browser `configure()` does not install automatic pending-span processing.
Browser apps often produce many short-lived fetch and interaction spans, so
automatic pending spans can significantly increase span volume, network
pressure, and ingestion cost in a user-facing environment.

For long-running browser operations where an immediate placeholder is useful,
call `startPendingSpan()` explicitly:

```js
import * as logfire from '@pydantic/logfire-browser'

const span = logfire.startPendingSpan('Load dashboard', { route: '/dashboard' })
try {
  await loadDashboard()
} finally {
  span.end()
}
```

Manual pending spans still add one placeholder span for each call. Node.js
applications get automatic pending spans from `@pydantic/logfire-node`; Browser
keeps this behavior explicit.

## Contributing

See [CONTRIBUTING.md](https://github.com/pydantic/logfire-js/blob/main/CONTRIBUTING.md) for development instructions.

## License

MIT
