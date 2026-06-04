---
title: Configuration
description: Configure Logfire TypeScript SDK runtime packages with tokens, service metadata, exporters, console output, and OpenTelemetry options.
---

# Configuration

Runtime packages configure OpenTelemetry for their environment:

- Node.js: `@pydantic/logfire-node`
- Browser: `@pydantic/logfire-browser`
- Cloudflare Workers: `@pydantic/logfire-cf-workers`

The `logfire` package provides manual spans and logs but does not configure exporters by itself.

## Service Metadata

Set stable service metadata so traces are easy to filter:

```ts
logfire.configure({
  environment: 'production',
  serviceName: 'checkout-api',
  serviceVersion: '1.0.0',
})
```

In Node.js, these can also come from:

```bash
LOGFIRE_SERVICE_NAME=checkout-api
LOGFIRE_SERVICE_VERSION=1.0.0
LOGFIRE_ENVIRONMENT=production
```

Node.js also accepts standard OpenTelemetry service metadata when the
Logfire-specific variables are omitted:

```bash
OTEL_SERVICE_NAME=checkout-api
OTEL_SERVICE_VERSION=1.0.0
```

Precedence is `configure()` options, then `LOGFIRE_*` environment variables,
then `OTEL_*` environment variables.

## Tokens

Node.js and Cloudflare read `LOGFIRE_TOKEN` by default. Browser code must not receive the token; use a backend proxy and configure `traceUrl` instead.

For local Node.js development, you can also let the CLI write project credentials:

```bash
npx logfire auth
npx logfire projects use my-project
```

`@pydantic/logfire-node` reads `.logfire/logfire_credentials.json` when no explicit `token` and no `LOGFIRE_TOKEN` are set. Token precedence in Node.js is:

1. `configure({ token })`
2. `LOGFIRE_TOKEN`
3. Local project credentials from `dataDir`, `LOGFIRE_CREDENTIALS_DIR`, or `.logfire`

If local credentials supply the token, their `logfire_api_url` is also used as the base URL unless `advanced.baseUrl` or `LOGFIRE_BASE_URL` overrides it. Browser and Cloudflare packages do not read local credential files.

In Node.js, `token` can also be a function when credentials rotate:

```ts
logfire.configure({
  advanced: {
    baseUrl: 'https://logfire-proxy.example.com',
  },
  token: async () => `Bearer ${await getCurrentAccessToken()}`,
  serviceName: 'desktop-app',
})
```

Token providers are resolved by the OpenTelemetry exporters when telemetry is
exported, not during `configure()`. When using a token provider, set
`advanced.baseUrl` or `LOGFIRE_BASE_URL` because Logfire cannot infer the API
base URL from a function token.

## Console Output

Enable console output while developing:

```ts
logfire.configure({
  console: true,
  serviceName: 'local-worker',
})
```

In Node.js, `LOGFIRE_CONSOLE=true` has the same effect and uses a console
minimum level of `info`, matching Python's default. To tune Node console output
without changing which telemetry is created, pass object-style console options:

```ts
logfire.configure({
  console: {
    minLevel: 'warning',
    includeTags: true,
    includeTimestamps: false,
  },
  serviceName: 'local-worker',
})
```

`console.minLevel` filters console output only. SDK-level `minLevel` controls
whether manual Logfire telemetry is created. Browser and Cloudflare
configuration currently support only boolean `console` values.

Spans without a Logfire level, including ordinary auto-instrumentation spans,
are treated as `info` for console filtering. Setting `console.minLevel` above
`info` hides those spans from local console output.

## Minimum Level

Use `minLevel` to stop low-severity manual Logfire telemetry before spans are
created. This is not console-output filtering; console configuration is
separate.

```ts
logfire.configure({
  minLevel: 'warning',
  serviceName: 'checkout-api',
})
```

`minLevel` accepts `trace`, `debug`, `info`, `notice`, `warning`, `error`, or
`fatal`, or numeric values from `logfire.Level`. Set `minLevel: null` to disable
a previously configured minimum. In Node.js, `LOGFIRE_MIN_LEVEL=warning` has
the same effect when the code configuration omits `minLevel`; invalid
environment values are warned about and ignored.

The filter applies to manual Logfire APIs. Log helpers and `reportError()` are
filtered by their level. `span()`, `startSpan()`, `startPendingSpan()`, and
`instrument()` are filtered only when the call or scoped client sets an
explicit level, so ordinary duration spans without a level are preserved. If a
filtered `span()` callback throws or rejects, the error still propagates to your
code but Logfire does not record it. Use `reportError()` or a span level at or
above the minimum when errors should always be reported.

## Sending Control

Node.js defaults to sending telemetry when a token is present. You can override this:

```ts
logfire.configure({
  sendToLogfire: false,
  serviceName: 'local-test',
})
```

Use `sendToLogfire: 'if-token-present'` when shared code should send only in environments that provide a token.

## Advanced Base URL

Use `LOGFIRE_BASE_URL` or `advanced.baseUrl` for self-hosted or local Logfire-compatible endpoints:

```ts
logfire.configure({
  advanced: {
    baseUrl: 'http://localhost:3000',
  },
  serviceName: 'local-test',
})
```

## OpenTelemetry Extensions

Node.js accepts additional span processors, metric readers, instrumentations, and custom ID generators. Browser accepts custom instrumentations, trace exporter headers, a context manager, and batch span processor options. Prefer the package-specific page when configuring runtime internals.
