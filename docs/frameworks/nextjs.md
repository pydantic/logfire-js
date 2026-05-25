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

Vercel production deployments can cache build and runtime configuration. If spans do not appear after changing tracing environment variables, clear the Vercel data cache for the project and redeploy.

## Client-Side Tracing

Install the browser package:

```bash
npm install @pydantic/logfire-browser @opentelemetry/auto-instrumentations-web
```

Create a proxy route or middleware that forwards browser OTLP requests to Logfire with the `Authorization` header. Browser requests should go to this same-origin proxy, not directly to the Logfire API.

Store the write token in a server-only environment variable such as `LOGFIRE_TOKEN`. Do not use a `NEXT_PUBLIC_` variable for the token.

```ts title="proxy.ts"
import { NextRequest, NextResponse } from 'next/server'

export default function proxy(request: NextRequest) {
  const url = request.nextUrl.clone()

  if (url.pathname === '/logfire-proxy/v1/traces') {
    const requestHeaders = new Headers(request.headers)
    requestHeaders.set('Authorization', process.env.LOGFIRE_TOKEN!)

    return NextResponse.rewrite(new URL(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? 'https://logfire-api.pydantic.dev/v1/traces'), {
      request: {
        headers: requestHeaders,
      },
    })
  }
}

export const config = {
  matcher: '/logfire-proxy/:path*',
}
```

Then configure the browser package in a client-only component:

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

If you import the component from a server-rendered page, load it with `next/dynamic` and `ssr: false` so browser instrumentation only runs in the browser.

See `examples/nextjs` and `examples/nextjs-client-side-instrumentation` for working projects.
