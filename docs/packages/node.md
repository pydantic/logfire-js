---
title: Node.js Package
description: Configure @pydantic/logfire-node for Node.js tracing, logging, metrics, automatic instrumentation, and manual spans.
---

# `@pydantic/logfire-node`

`@pydantic/logfire-node` is the main package for Node.js applications. It configures the OpenTelemetry Node SDK, exporters, automatic instrumentation, logs, metrics, and the manual `logfire` API.

## Install

```bash
npm install @pydantic/logfire-node
```

If you want automatic instrumentation, also install the OpenTelemetry instrumentation packages used by your application. The package expects OpenTelemetry dependencies as peers.

```bash
npm install @opentelemetry/auto-instrumentations-node
```

## Configure

```ts
import * as logfire from '@pydantic/logfire-node'

logfire.configure({
  serviceName: 'payments-api',
  serviceVersion: '1.0.0',
  environment: 'production',
})
```

The write token is read from `LOGFIRE_TOKEN` unless you pass `token`.

## Automatic Instrumentation

Call `configure()` before importing instrumented libraries:

```ts title="instrumentation.ts"
import * as logfire from '@pydantic/logfire-node'

logfire.configure({
  serviceName: 'payments-api',
})
```

Run the app with the instrumentation loaded first:

```bash
node --import ./instrumentation.js server.js
```

You can customize Node auto instrumentation with `nodeAutoInstrumentations`:

```ts
logfire.configure({
  nodeAutoInstrumentations: {
    '@opentelemetry/instrumentation-fs': { enabled: false },
    '@opentelemetry/instrumentation-http': { enabled: true },
  },
  serviceName: 'payments-api',
})
```

## Manual API

The package re-exports `logfire`, so you can use the same import for setup and spans:

```ts
import * as logfire from '@pydantic/logfire-node'

await logfire.span('charge card', {
  attributes: { amount: 42.5, currency: 'USD' },
  callback: async () => {
    logfire.info('calling payment provider')
  },
})
```

## Logs and Metrics

Logs and metrics are sent to Logfire by default when a token is present. Disable metrics when you only want traces and logs:

```ts
logfire.configure({
  metrics: false,
  serviceName: 'worker',
})
```

Use `console: true` to also print spans to the console while developing:

```ts
logfire.configure({
  console: true,
  serviceName: 'worker',
})
```

## Short-Lived Scripts

Flush before process exit:

```ts
await logfire.forceFlush()
await logfire.shutdown()
```

## Related Guides

- [Configuration](../guides/configuration.md)
- [Sampling](../guides/sampling.md)
- [Scrubbing](../guides/scrubbing.md)
- [Resource Attributes](../guides/resource-attributes.md)
