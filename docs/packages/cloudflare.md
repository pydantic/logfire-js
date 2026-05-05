---
title: Cloudflare Workers Package
description: Instrument Cloudflare Workers with @pydantic/logfire-cf-workers.
---

# `@pydantic/logfire-cf-workers`

`@pydantic/logfire-cf-workers` instruments Cloudflare Workers and exports the manual `logfire` API through the core `logfire` package.

## Install

```bash
npm install @pydantic/logfire-cf-workers logfire
```

Enable Node.js compatibility in Wrangler:

```json title="wrangler.jsonc"
{
  "compatibility_flags": ["nodejs_compat"]
}
```

For local development, set a write token in `.dev.vars`:

```bash title=".dev.vars"
LOGFIRE_TOKEN=your-write-token
LOGFIRE_ENVIRONMENT=development
```

For production, store `LOGFIRE_TOKEN` as a Worker secret.

## In-Process Instrumentation

```ts
import * as logfire from 'logfire'
import { instrument } from '@pydantic/logfire-cf-workers'

const handler = {
  async fetch(): Promise<Response> {
    logfire.info('worker request handled')
    return new Response('hello from Logfire')
  },
} satisfies ExportedHandler

export default instrument(handler, {
  service: {
    name: 'checkout-worker',
    namespace: '',
    version: '1.0.0',
  },
})
```

`instrument()` is an alias for `instrumentInProcess()`. It reads `LOGFIRE_TOKEN`, `LOGFIRE_ENVIRONMENT`, and `LOGFIRE_BASE_URL` from the Worker environment.

## Tail Workers

The package also supports Cloudflare Tail Worker flows:

- use `instrumentTail()` in the producer Worker
- use `exportTailEventsToLogfire()` in the Tail Worker

See `examples/cf-producer-worker` and `examples/cf-tail-worker` in this repository for the full wiring.

## Scrubbing

Pass `scrubbing` to control sensitive data scrubbing before telemetry is sent:

```ts
export default instrument(handler, {
  scrubbing: {
    extraPatterns: ['secret_token'],
  },
  service: {
    name: 'checkout-worker',
    namespace: '',
    version: '1.0.0',
  },
})
```
