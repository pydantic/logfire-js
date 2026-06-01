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

For rotating proxy or OAuth credentials, pass a token provider. The provider is
resolved by the OpenTelemetry exporters when telemetry is exported, so
`configure()` remains synchronous:

```ts
logfire.configure({
  advanced: {
    baseUrl: 'https://logfire-proxy.example.com',
  },
  token: async () => `Bearer ${await getCurrentAccessToken()}`,
  serviceName: 'payments-api',
})
```

When `token` is a function, set `advanced.baseUrl` or `LOGFIRE_BASE_URL`.
Logfire cannot infer the API base URL from a token provider.

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

## Minimum Level Filtering

Use `minLevel` to suppress low-severity manual Logfire telemetry before spans
are created:

```ts
logfire.configure({
  serviceName: 'payments-api',
  minLevel: 'warning',
})
```

Node.js also reads `LOGFIRE_MIN_LEVEL` when `configure()` does not receive a
`minLevel` option. Code configuration takes precedence over the environment,
and `minLevel: null` clears a previous setting. Invalid environment values are
warned about and ignored.

The filter applies to manual Logfire APIs. Log helpers and `reportError()` are
filtered by their level; `span()`, `startSpan()`, `startPendingSpan()`, and
`instrument()` are filtered only when the call or scoped client sets an
explicit level.

## Baggage Span Attributes

Use `baggage.spanAttributes` to copy selected active OpenTelemetry baggage
values onto Logfire manual spans and logs:

```ts
logfire.configure({
  serviceName: 'payments-api',
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

Console output defaults to a minimum level of `info`, matching Python's
console behavior. To change console output without changing which telemetry is
created, pass object-style console options:

```ts
logfire.configure({
  console: {
    minLevel: 'warning',
    includeTags: true,
    includeTimestamps: false,
  },
  serviceName: 'worker',
})
```

Use `console: { minLevel: 'debug' }` or `console: { minLevel: 'trace' }` when
you want lower-severity spans printed locally. `LOGFIRE_CONSOLE=true` remains a
boolean enable switch and uses the default `info` console minimum.

Spans without a Logfire level, including ordinary auto-instrumentation spans,
are treated as `info` for console filtering. Setting `console.minLevel` above
`info` hides those spans from local console output.

## Flush And Shutdown

Logfire batches telemetry through OpenTelemetry processors. For short-lived
scripts, tests, CLIs, and graceful process shutdown, explicitly shut down the
SDK before exiting:

```ts
try {
  logfire.info('work finished')
} finally {
  await logfire.shutdown({ timeoutMillis: 5000 })
}
```

`shutdown()` defaults to flushing first and then closes the underlying
OpenTelemetry SDK. Use `shutdown({ flush: false })` only when you have already
flushed or need to skip the explicit pre-shutdown flush.

Use `forceFlush()` when the process should keep running but queued telemetry
needs to be sent immediately:

```ts
await logfire.forceFlush({ timeoutMillis: 5000 })
```

`forceFlush()` drains the Logfire-managed span, log, evaluation, metric-reader,
and additional span processor paths without shutting down the SDK.

## Process Hooks

Logfire installs process hooks for `beforeExit`, `SIGTERM`,
`uncaughtExceptionMonitor`, and `unhandledRejection`.

On `beforeExit`, Logfire runs a bounded best-effort shutdown. On `SIGTERM`,
Logfire also runs bounded best-effort shutdown. If Logfire's listener is the
only `SIGTERM` listener, it then re-emits the signal with
`process.kill(process.pid, 'SIGTERM')` so Node keeps signal-style termination.
If your application installs its own `SIGTERM` handler, Logfire leaves process
termination to that application-level lifecycle code.

Logfire does not install a `SIGINT` handler and does not hook `process.on('exit',
...)`, because async telemetry flush cannot complete from the synchronous
`exit` event.

`uncaughtExceptionMonitor` observes and reports uncaught exceptions without
changing Node's default crash behavior. Any telemetry flush scheduled from that
hook is best-effort only. `unhandledRejection` observes, reports, and flushes on
the current Logfire path; this SDK does not restore Node's default fatal
unhandled-rejection behavior.

## Related Guides

- [Configuration](../configuration.md)
- [Sampling](../sampling.md)
- [Scrubbing](../scrubbing.md)
- [Resource Attributes](../resource-attributes.md)
