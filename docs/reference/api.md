---
title: API Overview
description: Overview of the main TypeScript SDK exports and package entry points.
---

# API Overview

This page is a package-level map of the public TypeScript SDK APIs. It is not a generated API reference.

## `logfire`

Manual tracing and logging:

- `instrument(fn, options?)`
- `span(message, options)` and `span(message, attributes, options, callback)`
- `startSpan(message, attributes?, options?)`
- `startPendingSpan(message, attributes?, options?)`
- `withTags(...tags)` and `withSettings(settings)` for scoped manual API clients
- `log()`, `trace()`, `debug()`, `info()`, `notice()`, `warning()`, `error()`, `fatal()`
- `reportError(message, error, extraAttributes?, options?)`
- `Level`

Configuration helpers and utilities:

- `configureLogfireApi()`
- `logfireApiConfig`
- `resolveBaseUrl()`
- `resolveSendToLogfire()`
- `serializeAttributes()`
- `LogfireAttributeScrubber`
- `NoopAttributeScrubber`
- `PendingSpanProcessor`
- `TailSamplingProcessor`
- `ULIDGenerator`
- sampling helpers such as `levelOrDuration()`

`configureLogfireApi()` accepts `baggage.spanAttributes` to copy allowlisted
active OpenTelemetry baggage keys onto Logfire manual spans/logs as
`baggage.<key>` attributes:

```ts
configureLogfireApi({
  baggage: {
    spanAttributes: ['tenant', 'region'],
  },
})
```

Projection is disabled by default. Explicit user attributes win on conflict,
missing keys are ignored, baggage metadata is ignored, and values are truncated
to 1000 characters. The Node and browser runtime packages expose the same shape
through `configure()`.

`configureLogfireApi()` also accepts `minLevel` to suppress low-severity manual
Logfire telemetry before spans are created. This is separate from console-output
configuration:

```ts
configureLogfireApi({
  minLevel: 'warning',
})
```

Use lowercase level names (`trace`, `debug`, `info`, `notice`, `warning`,
`error`, `fatal`) or numeric values from `Level`. Set `minLevel: null` to clear
a previously configured minimum. Log helpers and `reportError()` are filtered by
their level; span-like APIs are filtered only when the call or scoped client
sets an explicit level.

`configureLogfireApi()` accepts `jsonSchema` to control schema metadata for
serialized object and array attributes:

```ts
configureLogfireApi({
  jsonSchema: 'rich',
})
```

The default `rich` mode emits bounded best-effort nested schema metadata for
ordinary JSON-like values. Use `basic` to keep legacy broad top-level
`object`/`array` metadata, or `false` to omit `logfire.json_schema` entirely.
This setting controls schema metadata only; object and array attributes are
still serialized as JSON strings.

Manual spans accept an optional OpenTelemetry `SpanKind` so remote operations
(HTTP/RPC/WebSocket clients, server handlers not covered by
auto-instrumentation, queue producers and consumers) export with an accurate
kind instead of the `INTERNAL` default:

```ts
import { SpanKind } from '@opentelemetry/api'
import * as logfire from 'logfire'

await logfire.span('load live view records', {
  kind: SpanKind.CLIENT,
  attributes: {
    'websocket.endpoint': 'historical_query',
  },
  callback: async (span) => {
    // perform the outbound request/response operation
  },
})
```

`startSpan()`, `startPendingSpan()`, and `instrument()` accept the same `kind`
option, pending span placeholders keep the kind of their real span, and
omitting `kind` continues to produce `INTERNAL` spans. Log helpers do not take
a kind; zero-duration Logfire logs stay `INTERNAL`.

Subpaths:

- `logfire/evals`
- `logfire/vars`

## `@pydantic/logfire-node`

Node.js runtime setup:

- `configure(options?)`
- `logfireConfig`
- `forceFlush(options?)`
- `shutdown(options?)`
- `LogfireFlushOptions`
- `LogfireShutdownOptions`
- `DiagLogLevel`

The package also re-exports the public API from `logfire`.
Node `configure()` accepts `baggage.spanAttributes`, `minLevel`, and
`jsonSchema` for the shared manual API. It also accepts Node-only object-style
console options:

```ts
logfire.configure({
  console: {
    minLevel: 'warning',
    includeTags: true,
    includeTimestamps: true,
  },
})
```

`console.minLevel` filters console output only. Browser and Cloudflare
configuration remain boolean-only for console output. Spans without a Logfire
level are treated as `info` for console filtering.

## `@pydantic/logfire-browser`

Browser runtime setup:

- `configure(options)` returns an async shutdown function
- `DiagLogLevel`

The package also re-exports the public API from `logfire`.
Browser `configure()` accepts `baggage.spanAttributes`, `minLevel`, and
`jsonSchema` for the shared manual API.

## `@pydantic/logfire-cf-workers`

Cloudflare Worker setup:

- `instrument(handler, config)`
- `instrumentInProcess(handler, config)`
- `instrumentTail(handler, config)`
- `getTailConfig(config)`
- `exportTailEventsToLogfire(events, env)`

Unlike the Node and browser packages, this package does not re-export the manual `logfire` API as named exports. Import spans, logs, and `reportError` from `logfire` directly:

```ts
import * as logfire from 'logfire'
import { instrument } from '@pydantic/logfire-cf-workers'
```

The Cloudflare package's `instrument(handler, config)` configures Worker
runtime tracing. To wrap an individual function in a manual span, import the
core wrapper from `logfire`:

```ts
import { instrument as instrumentFunction } from 'logfire'
import { instrument as instrumentWorker } from '@pydantic/logfire-cf-workers'
```
