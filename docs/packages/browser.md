---
title: Browser Package
description: Configure @pydantic/logfire-browser for browser tracing with an authenticated backend proxy.
---

# `@pydantic/logfire-browser`

`@pydantic/logfire-browser` configures OpenTelemetry browser tracing and re-exports the manual `logfire` API for client-side spans and logs.

Browser telemetry must be sent through your own backend proxy. Do not put a Logfire write token in browser code, and do not configure browser code to send directly to `https://logfire-api.pydantic.dev/v1/traces`. Requests from arbitrary browser origins are blocked by CORS, and adding an `Authorization` header in client code would expose the write token.

## Install

```bash
npm install @pydantic/logfire-browser @opentelemetry/auto-instrumentations-web
```

## Configure

```ts
import { getWebAutoInstrumentations } from '@opentelemetry/auto-instrumentations-web'
import * as logfire from '@pydantic/logfire-browser'

const url = new URL('/logfire-proxy/v1/traces', window.location.origin)

logfire.configure({
  traceUrl: url.toString(),
  serviceName: 'web-app',
  serviceVersion: '1.0.0',
  instrumentations: [getWebAutoInstrumentations()],
})
```

`traceUrl` should point to a server-side endpoint that accepts OTLP trace requests from your browser instrumentation, forwards them to Logfire, and adds the `Authorization` header on the server.

Use `diagLogLevel` while troubleshooting local browser instrumentation:

```ts
logfire.configure({
  traceUrl: '/logfire-proxy/v1/traces',
  serviceName: 'web-app',
  instrumentations: [getWebAutoInstrumentations()],
  diagLogLevel: logfire.DiagLogLevel.ALL,
})
```

Only enable verbose diagnostic logging in development.

`@pydantic/logfire-browser` is published as an ESM package for modern browsers and frameworks. If your app uses SSR or SSG, run `configure()` only in browser runtime code.

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

## Proxy Requirement

A browser proxy should:

- accept requests from your frontend only
- add `Authorization: <write-token>` server-side
- forward to the Logfire OTLP trace endpoint
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

1. unregister configured instrumentations
2. force-flush spans
3. shut down the tracer provider

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
