---
title: Core API Package
description: Manual tracing, structured logs, error reporting, evaluations, and managed variables with the runtime-agnostic logfire package.
---

# Core API

The `logfire` package is the runtime-agnostic manual API. It does not configure a runtime SDK by itself; use it with a configured OpenTelemetry provider, or import it through a runtime package such as `@pydantic/logfire-node`, `@pydantic/logfire-browser`, or `@pydantic/logfire-cf-workers`.

Install it directly when a package or framework already configures OpenTelemetry for you:

```bash
npm install logfire
```

## Scoped Clients

Use `withTags()` or `withSettings()` to create a bound manual API client with
stable defaults:

```ts
import * as logfire from 'logfire'

const payments = logfire.withTags('payments')

payments.info('payment authorized', { payment_id: 'pay_123' })

await payments.span('capture payment', {
  attributes: { payment_id: 'pay_123' },
  callback: async () => {
    return capturePayment('pay_123')
  },
})
```

Scoped clients expose the same manual methods as the default API, including
`instrument()`, `span()`, `startSpan()`, `startPendingSpan()`, log helpers,
`reportError()`, `withTags()`, and `withSettings()`.

`withSettings()` currently supports reusable `tags` and a default `level`:

```ts
const debugTools = logfire.withSettings({
  tags: ['debug-tools'],
  level: logfire.Level.Debug,
})

debugTools.log('raw payload', { payload })
```

Scoped clients do not mutate global defaults and do not use callback-local
state. Per-call tags are appended after scoped tags, then duplicates are
removed while preserving first occurrence order. Per-call scalar options such
as `level` override scoped defaults, while level-specific helpers such as
`info()` and `error()` keep their explicit levels.

## Function Instrumentation

Use `instrument(fn, options?)` to wrap a sync or async function in a span while
preserving the original call signature, `this` value, return value, and thrown
or rejected errors:

```ts
import * as logfire from 'logfire'

const fetchProfile = logfire.instrument(
  async (userId: string) => {
    return getProfile(userId)
  },
  {
    message: 'fetch profile {user_id}',
    extractArgs: ['user_id'],
    tags: ['users'],
  }
)

await fetchProfile('user_123')
```

Supported options include:

- `message`: span message template. Defaults to `Calling ${fn.name || 'function'}`.
- `spanName`: stable OpenTelemetry span name when it should differ from the message template.
- `attributes`: static attributes added to every call span.
- `extractArgs`: `false` by default. Pass an explicit name array for stable positional argument attributes, or `true` for best-effort parameter-name extraction.
- `recordReturn`: records successful sync or async return values as span attributes on a best-effort basis.
- `tags`, `level`, and `parentSpan`: forwarded to the underlying span.

Prefer `extractArgs: ['user_id']` in production code. `extractArgs: true`
parses function source text and may produce unstable names after bundling,
minification, default parameters, or destructuring. Extracted arguments override
static `attributes` when they use the same key.

`recordReturn: true` records only successful return values. Serialization is
best effort; Logfire falls back instead of making a successful function call
fail because telemetry could not serialize the return value. For async
functions, the wrapper may return an equivalent chained promise so the resolved
or rejected value is preserved while the return value is recorded before the
span closes.

Scoped clients merge their settings with per-wrapper options:

```ts
const users = logfire.withSettings({
  tags: ['users'],
  level: logfire.Level.Debug,
})

const fetchProfileWithSpan = users.instrument(fetchProfileImpl, {
  message: 'fetch profile {user_id}',
  extractArgs: ['user_id'],
})
```

TypeScript decorators are intentionally not part of the JavaScript API in this
first pass.

## Spans

`span()` starts an active span, runs your callback, records thrown errors, and ends the span automatically.

```ts
import * as logfire from 'logfire'

await logfire.span('fetch user profile', {
  attributes: { user_id: 'user_123' },
  callback: async () => {
    return fetchProfile('user_123')
  },
})
```

Set `kind` when a manual span represents a remote operation. This preserves
OpenTelemetry service topology and dependency semantics:

```ts
import { SpanKind } from '@opentelemetry/api'
import * as logfire from 'logfire'

await logfire.span('request inventory service', {
  kind: SpanKind.CLIENT,
  attributes: { 'server.address': 'inventory.internal' },
  callback: async () => fetch('https://inventory.internal/items'),
})
```

`span()`, `startSpan()`, `startPendingSpan()`, and `instrument()` accept
`SpanKind.CLIENT`, `SpanKind.SERVER`, `SpanKind.PRODUCER`, or
`SpanKind.CONSUMER`. Omitting `kind` keeps OpenTelemetry's default
`SpanKind.INTERNAL` behavior. Pending placeholders use the same kind as their
real span.

Use `startSpan()` when you need to control the span lifetime yourself:

```ts
const span = logfire.startSpan('manual operation', { job_id: 'job_123' })

try {
  await runJob()
} finally {
  span.end()
}
```

Use `startPendingSpan()` when you want a long-running operation to appear in
Logfire immediately while you still control when the real span ends:

```ts
const span = logfire.startPendingSpan('load dashboard', { route: '/dashboard' })

try {
  await loadDashboard()
} finally {
  span.end()
}
```

The helper emits one `logfire.span_type = "pending_span"` placeholder at start
time and returns the real span. Runtimes with automatic pending-span processing,
such as `@pydantic/logfire-node`, suppress their automatic placeholder for this
one real span so the manual placeholder is not duplicated.

## Logs

Log helpers create point-in-time Logfire events:

```ts
logfire.info('payment authorized', { payment_id: 'pay_123' })
logfire.warning('retrying payment provider', { attempt: 2 })
logfire.error('payment provider failed', { provider: 'stripe' })
```

Message templates become structured telemetry. Attribute values are attached to the span and are available for search and SQL queries.

## Attribute Serialization

OpenTelemetry span attributes are scalar values or scalar arrays, so Logfire
serializes object and array attributes as JSON strings and adds
`logfire.json_schema` metadata to help the backend render them as structured
values.

By default, Logfire emits bounded best-effort nested schema metadata for
ordinary JSON-like values:

```ts
logfire.info('order received', {
  order: {
    id: 'ord_123',
    items: [{ sku: 'sku_123', quantity: 2 }],
  },
})
```

Schema inference is intentionally limited to normal JavaScript JSON-like data
such as objects, arrays, strings, numbers, booleans, `null`, and dates. It is
bounded by internal depth, object-property, and array-sampling limits. Exotic
objects fall back to broad metadata, and values that cannot be serialized are
recorded as `"[unserializable]"` instead of making application code fail.

Configure `jsonSchema` when you need a cheaper or quieter mode:

```ts
logfire.configureLogfireApi({
  jsonSchema: 'basic',
})
```

Use `jsonSchema: 'basic'` for legacy broad top-level `object`/`array` schemas,
or `jsonSchema: false` to omit `logfire.json_schema` entirely. This only
controls schema metadata; object and array attributes are still serialized as
JSON strings.

## Minimum Level Filtering

Configure `minLevel` to suppress low-severity manual Logfire telemetry before a
span is created. This is separate from console-output configuration.

```ts
import * as logfire from 'logfire'

logfire.configureLogfireApi({
  minLevel: 'warning',
})
```

The accepted names are `trace`, `debug`, `info`, `notice`, `warning`, `error`,
and `fatal`. You can also pass numeric values from `logfire.Level`, such as
`logfire.Level.Warning`. Set `minLevel: null` to clear a previous setting.

Log helpers are filtered by their level, and `log()` defaults to
`logfire.Level.Info`. `reportError()` uses `logfire.Level.Error`. Duration-style
APIs such as `span()`, `startSpan()`, `startPendingSpan()`, and `instrument()`
are filtered only when the call or a scoped client sets an explicit `level`.
This preserves ordinary unlevelled spans while still allowing opt-in debug span
filtering.

When a filtered `span()` call uses a callback, Logfire still runs the callback
with a no-op span. If the callback throws or rejects, that error propagates to
your code normally, but Logfire does not record it because the call was
filtered. Use `reportError()` or a span level at or above the minimum when
errors should always be reported.

## Errors

Use `reportError()` when you catch an exception and want it to appear as an error event in Logfire:

```ts
try {
  await syncCustomer()
} catch (error) {
  logfire.reportError('customer sync failed', error, { customer_id: 'cus_123' }, { tags: ['customers'] })
}
```

The caught value can be `unknown`; real `Error` values keep their stack traces
and can be fingerprinted for grouping. The third argument is always structured
attributes. Use the optional fourth argument for report options such as `tags`
or `parentSpan`.

Scoped clients merge their tags with per-call `reportError()` tags:

```ts
const customers = logfire.withTags('customers')

try {
  await syncCustomer()
} catch (error) {
  customers.reportError('customer sync failed', error, { customer_id: 'cus_123' }, { tags: ['sync'] })
}
```

Runtime packages can enable error fingerprinting so related errors group
together in Logfire. The JavaScript API does not include a Python-style
`exception()` helper in this first pass; use explicit catch blocks.

## Baggage Projection And Propagation

Use `baggage.spanAttributes` when stable OpenTelemetry baggage values should be
copied onto Logfire manual spans and logs:

```ts
import { configureLogfireApi } from 'logfire'

configureLogfireApi({
  baggage: {
    spanAttributes: ['tenant', 'region'],
  },
})
```

The Node and browser runtime packages expose the same config shape through
`logfire.configure()`. Projection is disabled by default and uses an explicit
allowlist. It affects manual `span()`, `startSpan()`, `startPendingSpan()`, log
helpers, `reportError()`, scoped clients, and `instrument()` spans. Automatic
instrumentation spans are not changed by this option.

Allowlisted baggage key `tenant` is emitted as `baggage.tenant`. If a call
already sets `baggage.tenant` in its explicit attributes, the explicit
attribute wins. Missing baggage keys are ignored, baggage metadata is ignored,
and baggage values remain strings truncated to 1000 characters.

Baggage is propagated across service boundaries. Do not store secrets,
credentials, session cookies, raw emails, or other sensitive user data in
baggage. Treat incoming trace context and baggage from untrusted callers as
untrusted input.

For non-HTTP carriers such as queue messages or background-job metadata, use
OpenTelemetry propagation APIs directly:

```ts
import { context, propagation } from '@opentelemetry/api'
import * as logfire from 'logfire'

const carrier: Record<string, string> = {}
propagation.inject(context.active(), carrier)

// Later, in a worker or queue consumer:
const extractedContext = propagation.extract(context.active(), carrier)
await context.with(extractedContext, async () => {
  await logfire.span('process job', {
    callback: async () => processJob(),
  })
})
```

A carrier is a serializable object such as HTTP headers, queue metadata, or job
attributes. OpenTelemetry `Context` is runtime-local execution state and is not
serializable. Baggage is propagated key/value metadata inside that context.
Logfire JS intentionally does not add generic `getContext()` /
`attachContext()` / `injectContext()` / `extractContext()` wrappers in this
first pass; use OpenTelemetry APIs directly when moving context between
processes or async execution boundaries.

## Subpath APIs

`logfire/evals` exports the JavaScript evaluation API. See [Evaluations](../evals.md).

`logfire/vars` exports managed variables. See [Managed Variables](../managed-variables.md).

## Runtime Setup

Use a runtime package unless your platform already configures OpenTelemetry:

- [`@pydantic/logfire-node`](node.md) for Node.js
- [`@pydantic/logfire-browser`](browser.md) for browsers
- [`@pydantic/logfire-cf-workers`](cloudflare.md) for Cloudflare Workers

