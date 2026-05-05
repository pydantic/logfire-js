---
title: Next.js
description: Use Logfire with Next.js server-side OpenTelemetry and optional client-side browser tracing.
---

# Next.js

Next.js can emit server-side OpenTelemetry through `@vercel/otel`. Client-side browser traces use `@pydantic/logfire-browser` and a proxy endpoint so the write token stays server-side.

## Server-Side Tracing

Install Vercel's OpenTelemetry package and the manual `logfire` API if you want to create spans in React Server Components, route handlers, or server actions:

```bash
npm install @vercel/otel logfire
```

Create `instrumentation.ts` in your project root or `src` directory:

```ts title="instrumentation.ts"
import { registerOTel } from '@vercel/otel'

export function register() {
  registerOTel({
    serviceName: 'nextjs-app',
  })
}
```

Set OTLP export to Logfire:

```bash title=".env.local"
OTEL_EXPORTER_OTLP_ENDPOINT=https://logfire-api.pydantic.dev
OTEL_EXPORTER_OTLP_HEADERS='Authorization=your-write-token'
```

Then use the manual API where useful:

```tsx
import * as logfire from 'logfire'

export default async function Page() {
  return logfire.span('render home page', {
    callback: async () => {
      logfire.info('loading homepage data')
      return <main>Hello</main>
    },
  })
}
```

## Client-Side Tracing

Install the browser package:

```bash
npm install @pydantic/logfire-browser @opentelemetry/auto-instrumentations-web
```

Create a proxy route or middleware that forwards browser OTLP requests to Logfire with the `Authorization` header. Then configure the browser package in a client-only component:

```tsx
'use client'

import { getWebAutoInstrumentations } from '@opentelemetry/auto-instrumentations-web'
import * as logfire from '@pydantic/logfire-browser'
import { useEffect } from 'react'

export function ClientInstrumentation() {
  useEffect(() => {
    const shutdown = logfire.configure({
      traceUrl: '/logfire-proxy/v1/traces',
      serviceName: 'nextjs-browser',
      instrumentations: [getWebAutoInstrumentations()],
    })

    return () => {
      void shutdown()
    }
  }, [])

  return null
}
```

See `examples/nextjs` and `examples/nextjs-client-side-instrumentation` for working projects.
