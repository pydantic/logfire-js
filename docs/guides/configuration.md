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

## Tokens

Node.js and Cloudflare read `LOGFIRE_TOKEN` by default. Browser code must not receive the token; use a backend proxy and configure `traceUrl` instead.

## Console Output

Enable console output while developing:

```ts
logfire.configure({
  console: true,
  serviceName: 'local-worker',
})
```

In Node.js, `LOGFIRE_CONSOLE=true` has the same effect.

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
