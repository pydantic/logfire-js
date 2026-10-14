---
title: Advanced browser configuration
description: Customize browser instrumentation, transport, span processing, and SDK lifecycle.
---

# Advanced browser configuration

Use these options when your application needs a custom transport, additional
instrumentation, or explicit provider cleanup. Direct frontend application
setup does not require a proxy.

The examples use `frontendOptions` from the [browser setup](../browser.md#configure).
Add these options to your application's existing `configureFrontend()` call.
The proxy and lifecycle examples explicitly use the lower-level `configure()`
instead; use one configuration at a time.

## Automatic instrumentation

`autoInstrumentations` is enabled by default with `configureFrontend()`.
The OpenTelemetry browser auto-instrumentations are registered before
`configure()` or `configureFrontend()` returns. Event listeners, `fetch` calls,
and XHR requests set up immediately afterward are traced. Call configuration
before the application registers listeners or makes requests.

`instrumentations` also accepts factories. Use them to defer custom instrumentation
construction until `configure()` has registered the provider.

When the page does not load Zone.js, automatic user interaction instrumentation
records one span for each event, such as a click, even when it reaches several
listeners. Every listener runs in that span's context. Spans and requests started
by a listener are its children. The span ends when the last listener returns or
throws, so tail sampling sees every listener's work.

A user interaction instrumentation passed through `instrumentations` keeps the
upstream behavior of one span for each listener.

### Collection options

Set `autoInstrumentations: false` to disable automatic instrumentation, or
`rum: { webVitals: false }` to disable Web Vitals capture. To keep Web Vitals
spans without metrics, use `rum: { webVitals: { metrics: false } }`. Nested
options preserve unrelated defaults: for example, setting `rum.session` or
`rum.webVitals.reportAllChanges` keeps Web Vitals metrics enabled. Disabling
`rum.session` also requires disabling Web Vitals and any other session-dependent
features, such as replay.

Use the lower-level `configure()` for custom endpoints, authentication, or a
telemetry proxy. It retains its opt-in instrumentation and RUM behavior. Global
error capture is on in both; see [Errors](errors.md#errors).
`configureFrontend()` accepts capture options, resource attributes, and exporter
tuning, while the frontend application owns transport and service identity.

### URL capture

`configureFrontend()` removes query strings, fragments, and URL credentials from
standard page/request URL attributes (`http.url`, `url.full`, `http.target`, and
`http.referrer`) before downstream span processors export them. It also removes
`url.query` and `url.fragment`, including on resource timing events. Set
`captureUrlQueryAndFragment: true` only when full URL capture is intended; URLs
can contain authentication tokens. RUM page URL attributes and replay URLs have
separate capture options. The lower-level `configure()` keeps its existing URL
behavior.

## Custom span processors

Use `spanProcessors` to register additional OpenTelemetry span processors with
the browser tracer provider:

```ts
logfire.configureFrontend({
  ...frontendOptions,
  spanProcessors: [customProcessor],
})
```

Custom processors are advanced extension points. They are registered before
Logfire's built-in exporting processor and before Logfire tail sampling, so use
them for enrichment or integration hooks rather than duplicate exporting unless
that is intentional.

## Baggage span attributes

Use `baggage.spanAttributes` to copy selected active OpenTelemetry baggage
values onto Logfire manual spans and logs:

```ts
logfire.configureFrontend({
  ...frontendOptions,
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

## Optional backend proxy

The restricted frontend application token is designed to be public, so a proxy
is not required to keep it secret. A proxy is useful for a first-party ingest
domain, application authentication, origin restrictions, or rate limits.

### First-party ingest domain

To reduce false-positive blocking by content blockers, route frontend
observability and session replay uploads through a neutral subdomain you
control. Follow the [frontend custom domain guide](../../frontend-custom-domain.md)
for the SDK configuration, path mappings, Cloudflare Worker example, security
requirements, CORS, CSP, and verification steps.

### Authenticated application proxy

Use an authenticated backend proxy when you need to verify application sessions
or keep a normal project write token on the server. A browser proxy should:

- authenticate browser requests and restrict their origins
- add `Authorization: <write-token>` server-side
- forward traces, metrics, and session replays to the corresponding Logfire
  ingest endpoints
- apply application-specific rate limits

For Next.js, see [Next.js](../../frameworks/nextjs.md). For a standalone browser example, see the `examples/browser` project in this repository.

Python telemetry forwarding is covered in the [Python backend proxy guide](../../python-telemetry-proxy.md).
Those helpers do not forward replay uploads.

## Separate replay destination

To store replays in a different Logfire deployment, pass a second restricted
frontend application destination. Traces and metrics still use the top-level
`baseUrl` and `token`; the browser sends each signal to one destination.

```ts
import { sessionReplayIntegration } from '@pydantic/logfire-session-replay/integration'

logfire.configureFrontend({
  baseUrl: 'https://rum.example.com',
  token: '<rum-frontend-application-token>',
  sessionReplay: {
    ...sessionReplayIntegration(),
    destination: {
      baseUrl: 'https://replay.example.com',
      token: '<replay-frontend-application-token>',
    },
  },
})
```

Both tokens must be restricted frontend application tokens, since the browser
can read them. The two deployments need the same application identity and
access to matching RUM session data to navigate from traces to replay.

## Replay proxy

A backend proxy can add application-specific authentication, origin checks, or
rate limits. Keep its replay headers synchronous so lifecycle uploads do not
wait on asynchronous work. In this example, `getCsrfToken()` is your application's
existing synchronous token getter:

```ts
import * as logfire from '@pydantic/logfire-browser'
import { sessionReplayIntegration } from '@pydantic/logfire-session-replay/integration'

logfire.configure({
  traceUrl: '/logfire-proxy/v1/traces',
  serviceName: 'web-app',
  autoInstrumentations: true,
  sessionReplay: {
    ...sessionReplayIntegration(),
    replayUrl: '/logfire-proxy/v1/replay',
    headers: () => ({
      'X-CSRF': getCsrfToken(),
    }),
  },
})
```

## Recording ownership

In a secure context with Web Locks and writable `localStorage`, recording
ownership allows one document at a time to write a recording. A document holds a Web Lock named after its
recording ID, and a record in `localStorage` holds the recording's next upload
sequence. Recording starts at once, but the document uploads nothing until it
holds the lock. A copied tab, such as a duplicated tab, whose recording another
document holds starts a new recording after waiting up to one second. A
document that continues a recording starts from the sequence in the shared
record, so it never reuses a sequence that another document uploaded. Until a
continued recording's lock is granted, `getRecordingId()` returns an empty
string, so the first spans of a reloaded page can lack a recording link. A new
recording's ID is available at once. The document releases the lock at
`pagehide`, so the page stays eligible for the back-forward cache. Do not call
`navigator.locks.query()` in the application: Chromium then evicts cached pages
that hold a lock. Without Web Locks or writable `localStorage`, two copied tabs
can still write one recording, as in earlier releases.

## Runtime lifecycle

`configureFrontend()` and `configure()` return an async cleanup function. Call it when your application
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

Browser pages also get a batch-processor flush when the document hides. Logfire
force-flushes the OpenTelemetry batch span processor when the document becomes
hidden or emits `pagehide`, and the trace exporter then sends the newest spans
of that flush first, in one small request that the browser lets outlive a
navigation, before the rest of the batch. `batchSpanProcessorConfig.documentHideKeepaliveBytes` sets the
estimated size of that first request. The default of 12 000 bytes leaves room
for the session replay upload, which shares the browser's keepalive quota on the
same events. The flush listens on `window`, so a span that your own `document`
`visibilitychange` listener ends is included whenever that listener registered.
A span ended in your own `pagehide` listener is included when the browser fires
`visibilitychange` afterwards, which Chromium does on navigation. You can disable
the flush with `batchSpanProcessorConfig.disableAutoFlushOnDocumentHide`, but
doing so means only explicit cleanup or normal batch timing will flush spans.

```ts
const cleanup = logfire.configure({
  traceUrl: '/logfire-proxy/v1/traces',
  serviceName: 'web-app',
})

await cleanup()
```

## Pending spans

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
