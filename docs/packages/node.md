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

Service metadata can be configured in code, with Logfire-specific environment
variables, or with standard OpenTelemetry service variables. Precedence is
`configure()` options, then `LOGFIRE_SERVICE_NAME` /
`LOGFIRE_SERVICE_VERSION`, then `OTEL_SERVICE_NAME` /
`OTEL_SERVICE_VERSION`.

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

Set `advanced.pendingSpans: false` or `LOGFIRE_PENDING_SPANS=false` to send
only finished spans. See [Pending Spans](../configuration.md#pending-spans).

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

Logfire keeps SQL text in `db.query.text` unscrubbed, so the mysql2
instrumentation runs with `maskStatement: true` by default. This keeps bound
parameter values out of the span. The instrumentation also replaces quoted
strings and numbers written into the SQL with `?`, but that masking is best
effort: a quote inside a SQL comment or a string that spans lines can leave a
literal in place, so pass secrets as parameters. The default applies even when
you pass your own
`nodeAutoInstrumentations` map. Set it to `false` to see literals, or pass a
`maskStatementHook` for custom masking:

```ts
logfire.configure({
  nodeAutoInstrumentations: {
    '@opentelemetry/instrumentation-mysql2': { maskStatement: false },
  },
})
```

Instrumentation instances that you pass through `instrumentations` use their
own configuration and do not get this default.

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
if Logfire's listener is the only `SIGTERM` listener, Logfire runs the same
shutdown and then re-emits the signal with `process.kill(process.pid, 'SIGTERM')`
so Node keeps signal-style termination.

If your application installs its own `SIGTERM` handler, Logfire only flushes on
`SIGTERM` and leaves shutdown and process termination to that handler. The SDK
keeps running, so spans the handler records while it drains work are exported.
End the handler with `await logfire.shutdown()`, after the last span it
records. This matters most when the handler calls `process.exit()`: `beforeExit`
does not run then, so spans recorded after the flush are otherwise lost. If the
handler lets the event loop empty instead, `beforeExit` shuts Logfire down as a
fallback.

Logfire does not install a `SIGINT` handler and does not hook `process.on('exit',
...)`, because async telemetry flush cannot complete from the synchronous
`exit` event.

`uncaughtExceptionMonitor` observes and reports uncaught exceptions without
changing Node's default crash behavior. Any telemetry flush scheduled from that
hook is best-effort only. `unhandledRejection` observes, reports, and flushes on
the current Logfire path; this SDK does not restore Node's default fatal
unhandled-rejection behavior.

To own process shutdown yourself, turn the hooks off:

```ts
logfire.configure({ advanced: { processHooks: false } })
```

With `processHooks: false`, `configure()` installs none of these listeners and
removes the ones an earlier call installed. The option applies to each call:
pass it every time you call `configure()`, because a call without it installs
the listeners again. With the hooks off, the application must:

- call `await logfire.shutdown()` at the end of its own shutdown, after the
  last span it records. It flushes and releases everything as usual;
- handle `SIGTERM`, and exit when its shutdown is done;
- handle `unhandledRejection` if the process must keep running. Without that
  handler, Node's default applies: an unhandled rejection crashes the process
  with exit code 1, and Logfire does not report it;
- report uncaught exceptions itself, if it wants them in Logfire.

To turn off single listeners, pass an object instead. A key you leave out
stays on. This keeps the exception reporting and turns off only the `SIGTERM`
listener, so your own `SIGTERM` handler owns that shutdown:

```ts
logfire.configure({ advanced: { processHooks: { sigterm: false } } })
```

Each key you set to `false` hands one duty to the application:

- `beforeExit: false`: call `await logfire.shutdown()` before the process
  exits on its own, or pending spans are lost;
- `sigterm: false`: handle `SIGTERM`, call `await logfire.shutdown()` after the
  last span, and exit;
- `uncaughtException: false`: report uncaught exceptions itself, if it wants
  them in Logfire;
- `unhandledRejection: false`: handle `unhandledRejection` if the process must
  keep running. Node's default crashes the process with exit code 1. If the
  `uncaughtException` listener is still on, Logfire records the rejection as an
  uncaught error, but the process usually exits before that record is exported,
  so do not rely on it reaching Logfire.

Like `false`, the object applies to each call, so pass it every time you call
`configure()`.

## Source Maps

If your service ships its `.map` files next to the built code, `enableSourceMaps`
makes Node rewrite recorded stack traces to your original files and lines:

```ts
logfire.configure({
  enableSourceMaps: true,
  serviceVersion: process.env.COMMIT_SHA,
})
```

It calls `process.setSourceMapsEnabled(true)`. Node reads maps only for files
loaded after that, so run `configure()` before your application modules load,
for example from a file passed to `node --import`. Do not install
`source-map-support` alongside: it replaces `Error.prepareStackTrace`, which
turns Node's own source map handling off.

## Related Guides

- [Configuration](../configuration.md)
- [Sampling](../sampling.md)
- [Scrubbing](../scrubbing.md)
- [Resource Attributes](../resource-attributes.md)
