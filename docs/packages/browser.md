---
title: Browser Package
description: Configure @pydantic/logfire-browser for browser tracing with an authenticated backend proxy.
---

# `@pydantic/logfire-browser`

`@pydantic/logfire-browser` configures OpenTelemetry browser tracing and re-exports the manual `logfire` API for client-side spans and logs.

Browser telemetry must be sent through your own backend proxy. Do not put a Logfire write token in browser code.

## Install

```bash
npm install @pydantic/logfire-browser @opentelemetry/auto-instrumentations-web
```

## Configure

```ts
import { getWebAutoInstrumentations } from '@opentelemetry/auto-instrumentations-web'
import * as logfire from '@pydantic/logfire-browser'

logfire.configure({
  traceUrl: '/logfire-proxy/v1/traces',
  serviceName: 'web-app',
  serviceVersion: '1.0.0',
  instrumentations: [getWebAutoInstrumentations()],
})
```

`traceUrl` should point to a server-side endpoint that forwards OTLP trace requests to Logfire and adds the `Authorization` header on the server.

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
