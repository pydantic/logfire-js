---
title: logfire Package
description: Manual tracing, structured logs, error reporting, evaluations, and managed variables with the runtime-agnostic logfire package.
---

# `logfire`

The `logfire` package is the runtime-agnostic manual API. It does not configure a runtime SDK by itself; use it with a configured OpenTelemetry provider, or import it through a runtime package such as `@pydantic/logfire-node`, `@pydantic/logfire-browser`, or `@pydantic/logfire-cf-workers`.

Install it directly when a package or framework already configures OpenTelemetry for you:

```bash
npm install logfire
```

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

Use `startSpan()` when you need to control the span lifetime yourself:

```ts
const span = logfire.startSpan('manual operation', { job_id: 'job_123' })

try {
  await runJob()
} finally {
  span.end()
}
```

## Logs

Log helpers create point-in-time Logfire events:

```ts
logfire.info('payment authorized', { payment_id: 'pay_123' })
logfire.warning('retrying payment provider', { attempt: 2 })
logfire.error('payment provider failed', { provider: 'stripe' })
```

Message templates become structured telemetry. Attribute values are attached to the span and are available for search and SQL queries.

## Errors

Use `reportError()` when you catch an exception and want it to appear as an error event in Logfire:

```ts
try {
  await syncCustomer()
} catch (error) {
  logfire.reportError('customer sync failed', error as Error, {
    customer_id: 'cus_123',
  })
}
```

Runtime packages can enable error fingerprinting so related errors group together in Logfire.

## Subpath APIs

`logfire/evals` exports the JavaScript evaluation API. See [Evaluations](../evals.md).

`logfire/vars` exports managed variables. See [Managed Variables](../managed-variables.md).

## Runtime Setup

Use a runtime package unless your platform already configures OpenTelemetry:

- [`@pydantic/logfire-node`](node.md) for Node.js
- [`@pydantic/logfire-browser`](browser.md) for browsers
- [`@pydantic/logfire-cf-workers`](cloudflare.md) for Cloudflare Workers
