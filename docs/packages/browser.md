---
title: Browser Package
description: Configure @pydantic/logfire-browser for browser tracing, RUM, metrics, and session replay.
---

# `@pydantic/logfire-browser`

`@pydantic/logfire-browser` configures OpenTelemetry browser tracing and re-exports the manual `logfire` API for client-side spans and logs.

Create a frontend application under **Project settings > Frontend applications**, then paste its generated setup into your browser code. Its token can only write telemetry for that frontend application and cannot read project data.

Follow the [Frontend guide](https://pydantic.dev/docs/logfire/observe/frontend/) for setup and verification. Never put a normal Logfire write token in browser code.

## Install

```bash
npm install @pydantic/logfire-browser
```

## Configure

```ts
import * as logfire from '@pydantic/logfire-browser'

const frontendApplicationConfig = {
  // Copy these region-specific values from the frontend application page.
  traceUrl: 'https://logfire-us.pydantic.dev/v1/traces',
  traceExporterHeaders: () => ({
    Authorization: 'Bearer <frontend-application-token>',
  }),
}

logfire.configure({
  ...frontendApplicationConfig,
  autoInstrumentations: true,
})
```

Logfire associates the token with the frontend application's service name, so it cannot report data for another application. Keep the generated `traceUrl` and `traceExporterHeaders` when adding the options shown in the rest of this page.

`autoInstrumentations` is opt-in and lazily loads OpenTelemetry browser auto-instrumentations after the Logfire browser provider is ready. For advanced integrations, `instrumentations` also accepts factories, so custom instrumentation construction can be deferred until `configure()` has registered the provider.

Use `diagLogLevel` while troubleshooting local browser instrumentation:

```ts
logfire.configure({
  ...frontendApplicationConfig,
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
  ...frontendApplicationConfig,
  rum: { session: true },
})
```

The session is stored in `sessionStorage`, so it is scoped to the current tab
and survives page reloads. It rotates after 30 minutes of inactivity or 4 hours
of total duration by default. Each span gets the OpenTelemetry `session.id`
semantic attribute.

Use `getRouteName` for the application's normalized route template and
`getSessionAttributes` for low-cardinality dimensions that should remain stable
for a browser session. Use `getUser` for the application's current user:

```ts
logfire.configure({
  ...frontendApplicationConfig,
  rum: {
    session: {
      getRouteName: () => router.currentRoute.value.matched.at(-1)?.path,
      getSessionAttributes: () => ({
        account_tier: currentAccount.tier,
        beta_user: currentUser?.isBeta,
      }),
      getUser: () =>
        currentUser === undefined
          ? undefined
          : {
              id: currentUser.id,
              name: currentUser.name,
              email: currentUser.email,
            },
    },
  },
})
```

`getRouteName` is evaluated for each span and becomes `logfire.page.route`.
`getUser` is also evaluated for each span. A non-empty `id` becomes `user.id`;
non-empty `name` and `email` values become `user.name` and `user.email`.
Use an opaque application id. Name and email are opt-in PII. The SDK emits
accepted strings unchanged, does not persist them, does not add them to Web
Vitals metric labels, and does not rotate the browser session when the current
user changes or logs out. Returning `undefined` represents an anonymous user or
logout. These client-asserted values are observational context, not
authentication, authorization, billing, or audit evidence.

`getSessionAttributes` is evaluated once per browser session, persisted across
same-tab reloads, and refreshed when the session rotates. Accepted values
become span attributes prefixed with `logfire.session.` and are copied into
replay chunk metadata when replay is enabled. Keys must match
`^[a-z][a-z0-9_]{0,63}$`; at most 20 entries are retained. Values must be
booleans, finite numbers, or strings no longer than 200 Unicode code points.
Invalid entries are omitted. Treat these dimensions as low-cardinality,
non-PII data because they are stored in `sessionStorage`.

Session-enabled spans also get `logfire.page.url.full` and
`logfire.page.url.path` by default for current page context. The full value is
`location.origin + location.pathname`, while the path value is
`location.pathname`; query strings and fragments are excluded. Network spans
may independently use OpenTelemetry `url.*` attributes for their request
target. Provide a callback to customize page attributes, explicitly restore the
raw page URL, or suppress them:

```ts
logfire.configure({
  ...frontendApplicationConfig,
  rum: {
    session: {
      urlAttributes: (url) => ({ full: url.href, path: url.pathname }),
    },
  },
})

logfire.configure({
  ...frontendApplicationConfig,
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
  ...frontendApplicationConfig,
  rum: { webVitals: true },
})
```

The browser SDK dynamically loads `web-vitals/attribution` only when
`rum.webVitals` is enabled. It records LCP, INP, CLS, FCP, and TTFB as short
OpenTelemetry spans named `web_vital.lcp`, `web_vital.inp`, `web_vital.cls`,
`web_vital.fcp`, and `web_vital.ttfb`. These point events carry exact
`logfire.span_type = 'log'`.

Every Web Vital span includes `web_vital.name`, `web_vital.value`,
`web_vital.delta`, `web_vital.id`, `web_vital.rating`, and
`web_vital.navigation_type`. Attribution fields include values such as
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
logfire.configure({
  ...frontendApplicationConfig,
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

To also export Web Vitals as OpenTelemetry histogram metrics, configure the
regional metrics endpoint with the same headers:

```ts
logfire.configure({
  ...frontendApplicationConfig,
  metrics: {
    metricUrl: new URL('/v1/metrics', frontendApplicationConfig.traceUrl).toString(),
    metricExporterHeaders: frontendApplicationConfig.traceExporterHeaders,
  },
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
meter provider. If that metrics runtime fails to start, the SDK emits an
explicit diagnostic and continues Web Vitals span reporting without a metric
recorder. It never retries configured authentication with empty headers.

Web Vitals metrics are histograms named
`logfire.browser.web_vital.lcp`, `logfire.browser.web_vital.inp`,
`logfire.browser.web_vital.cls`, `logfire.browser.web_vital.fcp`, and
`logfire.browser.web_vital.ttfb`. LCP, INP, FCP, and TTFB use unit `ms`; CLS
uses unit `1`.

Metric data point attributes are intentionally low-cardinality:
`web_vital.name` and `web_vital.rating` by default. They do not include
`session.id`, `logfire.page.url.full`, `logfire.page.url.path`,
`logfire.page.route`, `logfire.session.*`, Web Vital
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

## RUM Long Animation Frames

Enable `rum.longAnimationFrames` to detect and diagnose severe main-thread
congestion in supported Chromium browsers:

```ts
logfire.configure({
  ...frontendApplicationConfig,
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
logfire.configure({
  ...frontendApplicationConfig,
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

## Session Replay

Session replay is experimental in the JavaScript SDK while Logfire Platform
replay ingest and playback are still behind a feature flag. Keep replay behind
your own application flag and expect minor API, ingest, and UI behavior changes
before general availability.

Install the optional replay package when you want rrweb session recording:

```bash
npm install @pydantic/logfire-session-replay
```

Use the same endpoint host and headers for session replay:

```ts
const cleanup = logfire.configure({
  ...frontendApplicationConfig,
  sessionReplay: {
    load: () => import('@pydantic/logfire-session-replay'),
    replayUrl: new URL('/v1/replay', frontendApplicationConfig.traceUrl).toString(),
    headers: frontendApplicationConfig.traceExporterHeaders,
    maskAllText: true,
    maskAllInputs: true,
  },
})

// The property exists synchronously whenever sessionReplay is configured.
await cleanup.sessionReplay?.flush()
await cleanup.sessionReplay?.stop() // replay only; tracing remains active
await cleanup() // full SDK cleanup
```

`sessionReplay` implies default RUM session behavior. Replay chunks and browser
spans share `session.id`. Spans started after replay has
loaded and sampled into `full` or `buffer` mode include
`logfire.session_replay.active` and `logfire.session_replay.mode`. Those active
attributes are truthful best-effort annotations, not the primary correlation
key; early spans should be correlated to replay by browser session id and replay
time bounds. Replay chunks do not include per-trace correlation metadata.

Before lazy replay startup completes, after startup failure, and after replay is
stopped, the facade reports `mode: 'off'` and `recording: false`. Its `stop()`
method is idempotent and generation-scoped. Session identity remains available
through `getBrowserSessionId()`, not the replay facade.

Replays shorter than `minSessionDurationMs` are not uploaded (5 seconds by
default). An earlier flush remains buffered until the minimum is reached, and
stopping earlier discards the replay. Set `minSessionDurationMs: 0` only when
shorter replays must be delivered.

Browser-session inactivity currently means span inactivity: replay startup
initializes and touches the session once before loading the optional peer, but
subsequent replay events only peek at the session id and do not refresh the
timeout. Span starts are the ongoing automatic activity;
`getBrowserSessionId()` also explicitly touches the session.

When `sessionReplay.getDistinctId` is not configured, replay uses the current
`rum.session.getUser()?.id` so replay rows and span `user.id` agree. An explicit
`getDistinctId` remains authoritative. A static `sessionReplay.distinctId`
remains the fallback while the selected live getter returns `undefined`.

After a replay reaches the minimum duration, hiding the document or receiving
`pagehide` makes a bounded best-effort start of the earliest compressed chunks.
Its 48,000-byte aggregate
budget is shared across its own unfinished keepalive requests, while the
browser's keepalive quota is also shared with unrelated page traffic. Delivery
after page freeze or termination is therefore not guaranteed. Functional
`headers` and `token` values are resolved for every upload; an asynchronous
resolver can finish too late for a lifecycle request. The generated frontend
application headers are synchronous and work for these uploads.

Ordinary replay uploads automatically fall back to synchronous gzip if a
restrictive Content Security Policy blocks the compressor worker. The fallback
preserves the batch and is remembered for the active replay controller, but it
may briefly use the main thread.

A backend proxy can add application-specific authentication, origin checks, or
rate limits. Keep its replay headers synchronous so lifecycle uploads do not
wait on asynchronous work:

```ts
logfire.configure({
  traceUrl: '/logfire-proxy/v1/traces',
  serviceName: 'web-app',
  sessionReplay: {
    load: () => import('@pydantic/logfire-session-replay'),
    replayUrl: '/logfire-proxy/v1/replay',
    headers: () => ({
      'X-CSRF': getCsrfToken(),
    }),
  },
})
```

Replay masks all rendered text and input values by default, leaves console
capture off, and removes query strings and fragments from captured page,
fetch/XHR, and navigation URLs. Network and navigation capture remain enabled.
These replay-package defaults are inherited when browser options are omitted.

Use `blockSelector` to omit a subtree. Set `maskAllText: false` only when
visible text recording is acceptable; `maskTextSelector` can then selectively
mask sensitive regions. `captureConsole: true` is an explicit opt-in, and
`redactUrlPatterns: []` explicitly restores raw replay URLs. Text masking does
not scrub DOM attributes, CSS content, resource URLs, or arbitrary custom-event
payloads, so those values still require application-side care.

When testing replay locally, browser privacy extensions or ad blockers may block
requests or dynamic imports whose URLs contain terms such as `session-replay`.
If replay fails to start with `ERR_BLOCKED_BY_CLIENT`, test in a clean profile
or disable the extension for the local app. Vite workspace examples may also
need to load `@rrweb/record`'s browser ESM build
(`@rrweb/record/dist/record.js`) rather than its CommonJS build when importing
unpublished workspace output directly.

## Custom Span Processors

Use `spanProcessors` to register additional OpenTelemetry span processors with
the browser tracer provider:

```ts
logfire.configure({
  ...frontendApplicationConfig,
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
  ...frontendApplicationConfig,
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
  ...frontendApplicationConfig,
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

## Optional Backend Proxy

Use a backend proxy when you need to authenticate browser requests, restrict
origins, or apply application-specific rate limits. A browser proxy should:

- authenticate browser requests and restrict their origins
- add `Authorization: <write-token>` server-side
- forward traces, metrics, and session replays to the corresponding Logfire
  ingest endpoints
- apply application-specific rate limits

For Next.js, see [Next.js](../frameworks/nextjs.md). For a standalone browser example, see the `examples/browser` project in this repository.

## Python Backend Proxy (Telemetry Only)

Python backends can use the `logfire.forward_export_request_starlette` and
`logfire.forward_export_request` helpers to create a trace, log, and metric
telemetry ingress endpoint without exposing the write token.

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

These Python helpers cannot forward session replay. Replay is a separate
capability and must not be routed through this telemetry-only endpoint. A replay
proxy needs its own authenticated route that:

- accepts `POST /v1/replay/{session_id}?seq={sequence}`
- percent-encodes the session id as one path segment and the sequence as one
  query value
- forwards the request bytes and their `Content-Type` and
  `Content-Encoding` unchanged
- adds the Logfire write token only on the server
- applies the application's authentication, exact origin policy, rate limits,
  and request-size limit

This repository's
[`examples/browser`](https://github.com/pydantic/logfire-js/tree/main/examples/browser)
and
[`examples/browser-rum-replay`](https://github.com/pydantic/logfire-js/tree/main/examples/browser-rum-replay)
projects contain runnable JavaScript development proxies for traces, metrics,
and replay. They bind to loopback and are reference helpers for local
development, not a production proxy deployment design.

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

Protect this endpoint in production. Treat browser telemetry ingress like any other externally reachable write endpoint: clients can be numerous, retry requests, duplicate payloads, or send malicious data. Use your normal authentication, session, CORS, and rate-limiting controls. Configure CORS for the exact app origins that should send telemetry; do not use wildcard credentialed CORS.

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
2. close and shut down Long Animation Frame reporting when enabled
3. unregister configured instrumentations
4. await Web Vitals startup and shutdown when enabled
5. force-flush and shut down metrics when configured
6. force-flush spans
7. shut down the tracer provider
8. clear SDK-owned browser session state

If any cleanup step fails, Logfire still attempts the later steps before
returning the first failure. Later calls return the same settled cleanup promise
rather than starting another cleanup cycle.

Await cleanup before configuring a replacement generation:

```ts
const cleanupA = logfire.configure({
  traceUrl: '/logfire-proxy/v1/traces-a',
  serviceName: 'web-app-a',
})

await cleanupA()

const cleanupB = logfire.configure({
  traceUrl: '/logfire-proxy/v1/traces-b',
  serviceName: 'web-app-b',
})
```

An active or still-cleaning configuration rejects another `configure()` call.
Between generations, retained tracers create non-recording spans. A span remains
owned by the generation under which it started, so finish A spans before cleanup
A when their export must be guaranteed. A rejected cleanup makes the browser
runtime terminal until the page reloads.

The browser runtime keeps its OpenTelemetry tracer provider, context manager,
and default propagator page-stable and does not disable them during ordinary
cleanup. Application-owned globals are preserved independently. Register an
application context manager before Logfire and omit `contextManager` from
Logfire configuration; a context manager cannot be swapped between Logfire
generations. Ensure the bundler deduplicates both `@pydantic/logfire-browser`
and `logfire`, because reconfiguration across duplicate physical copies is not
supported.

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
