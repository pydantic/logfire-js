---
title: Next.js
description: Use Logfire with Next.js server-side OpenTelemetry and optional client-side browser tracing.
---

# Next.js

Next.js can emit server-side OpenTelemetry through `@vercel/otel`. Use `@pydantic/logfire-browser` with a restricted frontend application token for client-side browser traces.

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

Create a frontend application under **Project settings > Frontend applications**, then copy its generated browser setup. The token can only write telemetry for that frontend application and cannot read project data. Follow the [Frontend guide](https://pydantic.dev/docs/logfire/observe/frontend/) for setup and verification.

For Next.js 15.3 and later, configure the browser package in
`instrumentation-client.ts` using the generated `traceUrl` and
`traceExporterHeaders` values. Next.js loads this file once in the browser
before the application becomes interactive.

```ts title="instrumentation-client.ts"
import * as logfire from '@pydantic/logfire-browser'

logfire.configure({
  traceUrl: 'https://logfire-us.pydantic.dev/v1/traces',
  traceExporterHeaders: () => ({
    Authorization: 'Bearer <frontend-application-token>',
  }),
  autoInstrumentations: true,
})
```

### Optional Proxy

The restricted frontend application token does not need a proxy to keep it secret. Preserve an existing telemetry proxy, or add one only when the application needs its own authentication, origin restrictions, or rate limits. Follow the [browser package's optional proxy guidance](../packages/browser.md#optional-backend-proxy) rather than treating a Next.js rewrite as part of normal setup.

See `examples/nextjs` and `examples/nextjs-client-side-instrumentation` for working projects.
