---
title: Browser Package
description: Configure @pydantic/logfire-browser for browser tracing with an authenticated backend proxy.
---

# `@pydantic/logfire-browser`

`@pydantic/logfire-browser` configures OpenTelemetry browser tracing and re-exports the manual `logfire` API for client-side spans and logs.

Browser telemetry must be sent through your own backend proxy. Do not put a Logfire write token in browser code, and do not configure browser code to send directly to `https://logfire-api.pydantic.dev/v1/traces`. Requests from arbitrary browser origins are blocked by CORS, and adding an `Authorization` header in client code would expose the write token.

## Install

```bash
npm install @pydantic/logfire-browser
```

## Configure

```ts
import * as logfire from '@pydantic/logfire-browser'

const url = new URL('/logfire-proxy/v1/traces', window.location.origin)

logfire.configure({
  traceUrl: url.toString(),
  serviceName: 'web-app',
  serviceVersion: '1.0.0',
  autoInstrumentations: true,
})
```

`traceUrl` should point to a server-side endpoint that accepts OTLP trace requests from your browser instrumentation, forwards them to Logfire, and adds the `Authorization` header on the server.

`autoInstrumentations` is opt-in and lazily loads OpenTelemetry browser auto-instrumentations after the Logfire browser provider is ready. For advanced integrations, `instrumentations` also accepts factories, so custom instrumentation construction can be deferred until `configure()` has registered the provider.

Use `diagLogLevel` while troubleshooting local browser instrumentation:

```ts
logfire.configure({
  traceUrl: '/logfire-proxy/v1/traces',
  serviceName: 'web-app',
  autoInstrumentations: true,
  diagLogLevel: logfire.DiagLogLevel.ALL,
})
```

Only enable verbose diagnostic logging in development.

`@pydantic/logfire-browser` is published as an ESM package for modern browsers and frameworks. If your app uses SSR or SSG, run `configure()` only in browser runtime code.

## RUM Session Identity

Enable `rum.session` to attach an SDK-owned browser session id to every span
created by the configured browser provider:

```ts
logfire.configure({
  traceUrl: '/logfire-proxy/v1/traces',
  serviceName: 'web-app',
  rum: { session: true },
})
```

The session is stored in `sessionStorage`, so it is scoped to the current tab
and survives page reloads. It rotates after 30 minutes of inactivity or 4 hours
of total duration by default. Each span gets `session.id` and
`browser.session.id`; `session.id` is the OpenTelemetry semantic attribute and
`browser.session.id` is emitted for Logfire Platform compatibility.

Session-enabled spans also get `logfire.page.url.full` and
`logfire.page.url.path` by default for current page context. The full value uses
`location.href`, including query strings and fragments, while the path value
uses `location.pathname`. Network spans may independently use OpenTelemetry
`url.*` attributes for their request target. If your URLs may contain sensitive
query strings or fragments, sanitize or suppress page URL attributes:

```ts
logfire.configure({
  traceUrl: '/logfire-proxy/v1/traces',
  serviceName: 'web-app',
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
  traceUrl: '/logfire-proxy/v1/traces',
  serviceName: 'web-app',
  rum: {
    session: {
      urlAttributes: false,
    },
  },
})
```

Call `getBrowserSessionId()` after configuring `rum.session` when another
browser integration needs the SDK-owned session id before the first span.

## RUM Web Vitals

Enable `rum.webVitals` to record Core Web Vitals from real browser sessions:

```ts
logfire.configure({
  traceUrl: '/logfire-proxy/v1/traces',
  serviceName: 'web-app',
  rum: { webVitals: true },
})
```

The browser SDK dynamically loads `web-vitals/attribution` only when
`rum.webVitals` is enabled. It records LCP, INP, CLS, FCP, and TTFB as short
OpenTelemetry spans named `web_vital.lcp`, `web_vital.inp`, `web_vital.cls`,
`web_vital.fcp`, and `web_vital.ttfb`.

Every Web Vital span includes `web_vital.name`, `web_vital.value`,
`web_vital.delta`, `web_vital.id`, `web_vital.rating`, and
`web_vital.navigation_type`. Attribution fields include values such as
`web_vital.lcp.target`, `web_vital.inp.target`, and
`web_vital.cls.largest_shift_target`.

`rum.webVitals` implies default `rum.session` behavior so Web Vital spans get
session and URL attributes. To sanitize URLs while reporting Web Vitals, pass
session options alongside Web Vitals:

```ts
logfire.configure({
  traceUrl: '/logfire-proxy/v1/traces',
  serviceName: 'web-app',
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

Web Vitals observers live for the page lifetime. The first successful startup
fixes `reportAllChanges`, `generateTarget`, and
`includeProcessedEventEntries`; later `configure()` calls can update the tracer
and metric destination but ignore changed observer options with a diagnostic
warning. If the initial lazy load or observer startup fails, a later
`configure()` call retries it.

To emit native OpenTelemetry histogram metrics in parallel with those spans,
configure a browser-safe metrics proxy and opt Web Vitals into metrics:

```ts
logfire.configure({
  traceUrl: '/logfire-proxy/v1/traces',
  metrics: {
    metricUrl: '/logfire-proxy/v1/metrics',
  },
  serviceName: 'web-app',
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

## Session Replay

Session replay is experimental in the JavaScript SDK while Logfire Platform
replay ingest and playback are still behind a feature flag. Keep replay behind
your own application flag and expect minor API, ingest, and UI behavior changes
before general availability.

Install the optional replay package when you want rrweb session recording:

```bash
npm install @pydantic/logfire-session-replay
```

Configure replay with a browser-safe proxy endpoint:

```ts
logfire.configure({
  traceUrl: '/logfire-proxy/v1/traces',
  serviceName: 'web-app',
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

`sessionReplay` implies default RUM session behavior. Replay chunks and browser
spans share `session.id` / `browser.session.id`. Spans started after replay has
loaded and sampled into `full` or `buffer` mode include
`logfire.session_replay.active` and `logfire.session_replay.mode`. Those active
attributes are truthful best-effort annotations, not the primary correlation
key; early spans should be correlated to replay by browser session id and replay
time bounds. The browser SDK does not populate replay `traceIds` from
active-span polling.

Direct token usage is available as an advanced escape hatch, but it exposes the
write token to browser code and should not be the default browser deployment
model:

```ts
logfire.configure({
  traceUrl: '/logfire-proxy/v1/traces',
  serviceName: 'web-app',
  sessionReplay: {
    load: () => import('@pydantic/logfire-session-replay'),
    replayUrl: 'https://logfire-api.pydantic.dev/v1/replay',
    token: '<write-token>',
  },
})
```

Replay can capture console, fetch/XHR, navigation, and DOM events. Keep input
masking enabled by default, use `blockSelector` or `maskTextSelector` for
sensitive regions, and disable capture classes that are not appropriate for
your application.

When testing replay locally, browser privacy extensions or ad blockers may block
requests or dynamic imports whose URLs contain terms such as `session-replay`.
If replay fails to start with `ERR_BLOCKED_BY_CLIENT`, test in a clean profile
or disable the extension for the local app. Vite workspace examples may also
need to load rrweb's browser ESM build (`rrweb/dist/rrweb.js`) rather than its
CommonJS build when importing unpublished workspace output directly.

## Custom Span Processors

Use `spanProcessors` to register additional OpenTelemetry span processors with
the browser tracer provider:

```ts
logfire.configure({
  traceUrl: '/logfire-proxy/v1/traces',
  serviceName: 'web-app',
  spanProcessors: [customProcessor],
})
```

Custom processors are advanced extension points. They are registered before
Logfire's built-in exporting processor and before Logfire tail sampling, so use
them for enrichment or integration hooks rather than duplicate exporting unless
that is intentional.

## Manual Client Events

```ts
document.querySelector('button')?.addEventListener('click', () => {
  logfire.info('checkout button clicked')
})
```

Report caught errors with `reportError()`:

```ts
window.addEventListener('error', (event) => {
  logfire.reportError('uncaught browser error', event.error, { filename: event.filename }, { tags: ['browser'] })
})
```

## Minimum Level Filtering

Use `minLevel` to suppress low-severity manual Logfire telemetry before spans
are created:

```ts
logfire.configure({
  traceUrl: '/logfire-proxy/v1/traces',
  serviceName: 'web-app',
  minLevel: 'warning',
})
```

Browser configuration does not read Logfire environment variables. Pass
`minLevel` in code, or pass `minLevel: null` to clear a previous setting. The
filter applies to manual Logfire APIs. Log helpers and `reportError()` are
filtered by their level; `span()`, `startSpan()`, `startPendingSpan()`, and
`instrument()` are filtered only when the call or scoped client sets an
explicit level.

## Baggage Span Attributes

Use `baggage.spanAttributes` to copy selected active OpenTelemetry baggage
values onto Logfire manual spans and logs:

```ts
logfire.configure({
  traceUrl: '/logfire-proxy/v1/traces',
  serviceName: 'web-app',
  baggage: {
    spanAttributes: ['tenant', 'region'],
  },
})
```

Projection is disabled by default and allowlisted. Configured key `tenant` is
emitted as `baggage.tenant` on manual spans/logs, including `span()`,
`startSpan()`, `startPendingSpan()`, log helpers, `reportError()`, scoped
clients, and `instrument()` spans. Explicit attributes win on conflict, missing
keys are ignored, and values are truncated to 1000 characters.

Baggage propagates across service boundaries. Do not store secrets,
credentials, session cookies, raw emails, or other sensitive user data in
baggage.

## Proxy Requirement

A browser proxy should:

- accept requests from your frontend only
- add `Authorization: <write-token>` server-side
- forward traces to the Logfire OTLP trace endpoint and metrics to the OTLP
  metrics endpoint
- apply authentication, rate limiting, or origin checks for production apps

For Next.js, see [Next.js](../frameworks/nextjs.md). For a standalone browser example, see the `examples/browser` project in this repository.

## Python Backend Proxy

Python backends can use the `logfire.forward_export_request_starlette` and `logfire.forward_export_request` helpers to create a telemetry ingress endpoint without exposing the write token.

For FastAPI/Starlette, use `logfire.forward_export_request_starlette` in an endpoint, for example:

```py title="main.py"
from fastapi import Depends, FastAPI, Request

import logfire

logfire.configure()
app = FastAPI()


async def verify_user_session():
    # Add authentication, session, rate limiting, or origin checks here.
    pass


@app.post('/logfire-proxy/{path:path}', dependencies=[Depends(verify_user_session)])
async def proxy_browser_telemetry(request: Request):
    return await logfire.forward_export_request_starlette(request)
```

The `{path:path}` route parameter is required. `forward_export_request_starlette` rejects paths other than `/v1/traces`, `/v1/logs`, and `/v1/metrics` so that it can forward to the appropriate Logfire backend endpoint.

For Django, Flask, Litestar, or a custom HTTP server, use `forward_export_request` directly, e.g:

```py title="main.py"
import logfire

logfire.configure()


def my_custom_proxy_route(request):
    response = logfire.forward_export_request(
        path=request.path.removeprefix('/logfire-proxy'),
        headers=request.headers,
        body=request.read(),
    )
    # Replace CustomFrameworkResponse with your framework's response class.
    return CustomFrameworkResponse(
        content=response.content,
        status_code=response.status_code,
        headers=response.headers,
    )
```

Protect this endpoint in production. Treat browser telemetry ingress like any other externally reachable write endpoint: clients can be numerous, retry requests, duplicate payloads, or send malicious data. Use your normal authentication, session, CORS, and rate-limiting controls. Configure CORS for the app origin that should send telemetry; avoid `*` unless you intentionally operate a public telemetry ingestion endpoint.

Caveats:

- These functions only forward requests directly to Logfire. If you have alternative backends configured, you will need to proxy to them manually.
- These functions merely forward the data as is. They do not perform any validation, sanitization, or transformation.
- Requests are placed in a queue and forwarded in a background thread. The queue is limited to 1000 requests and 64MB of memory. If the queue is full, new requests will be dropped. This is to prevent overwhelming your backend with large volumes of telemetry data, which could be used in a DoS attack.

## Runtime Lifecycle

`configure()` returns an async cleanup function. Call it when your application
is tearing down the configured browser provider, such as in tests, previews, or
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

```ts
const cleanup = logfire.configure({
  traceUrl: '/logfire-proxy/v1/traces',
  serviceName: 'web-app',
})

await cleanup()
```

## Pending Spans

Browser `configure()` does not install automatic pending-span processing.
Browser apps often produce many short-lived fetch and interaction spans, so
automatic pending spans can significantly increase span volume, network
pressure, and ingestion cost in a user-facing environment.

For long-running browser operations where an immediate placeholder is useful,
call `startPendingSpan()` explicitly:

```ts
const span = logfire.startPendingSpan('load dashboard', { route: '/dashboard' })

try {
  await loadDashboard()
} finally {
  span.end()
}
```

Manual pending spans still add one placeholder span for each call. Node.js
applications get automatic pending spans from `@pydantic/logfire-node`; Browser
keeps this behavior explicit.
