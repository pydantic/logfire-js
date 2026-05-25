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

`traceUrl` should point to a server-side endpoint that forwards OTLP trace requests to Logfire and adds the `Authorization` header on the server.

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
  if (event.error instanceof Error) {
    logfire.reportError('uncaught browser error', event.error)
  }
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

Python backends can use the experimental `logfire.experimental.forwarding` helpers to forward browser OTLP requests without exposing the write token.

For FastAPI, mount `logfire_proxy` on a path that captures the OTLP suffix:

```py title="main.py" skip-run="true" skip-reason="server-start"
from fastapi import Depends, FastAPI, Request

import logfire
from logfire.experimental.forwarding import logfire_proxy

logfire.configure()
app = FastAPI()


async def verify_user_session():
    # Add authentication, rate limiting, or origin checks here.
    pass


@app.post('/logfire-proxy/{path:path}', dependencies=[Depends(verify_user_session)])
async def proxy_browser_telemetry(request: Request):
    return await logfire_proxy(request)
```

The `{path:path}` route parameter is required so `/logfire-proxy/v1/traces` forwards the `/v1/traces` OTLP path. The helper rejects paths other than `/v1/traces`, `/v1/logs`, and `/v1/metrics`, strips incoming credentials, adds the configured Logfire token, and limits request bodies to 50 MB by default.

For Starlette, mount the same handler as a route:

```py title="main.py" skip-run="true" skip-reason="server-start"
from starlette.applications import Starlette
from starlette.routing import Route

import logfire
from logfire.experimental.forwarding import logfire_proxy

logfire.configure()

app = Starlette(
    routes=[
        Route('/logfire-proxy/{path:path}', logfire_proxy, methods=['POST']),
    ],
)
```

For Django, Flask, Litestar, or a custom HTTP server, use `forward_export_request` directly:

```py title="main.py" skip-run="true" skip-reason="server-start"
import logfire
from logfire.experimental.forwarding import forward_export_request

logfire.configure()


def my_custom_proxy_route(request):
    response = forward_export_request(
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

Protect this endpoint in production. Any client that can reach it can send telemetry to your Logfire project.

## Shutdown

`configure()` returns an async shutdown function:

```ts
const shutdown = logfire.configure({
  traceUrl: '/logfire-proxy/v1/traces',
  serviceName: 'web-app',
})

window.addEventListener('pagehide', () => {
  void shutdown()
})
```
