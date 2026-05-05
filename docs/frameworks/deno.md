---
title: Deno
description: Configure Deno OpenTelemetry export to Logfire and use the logfire package for manual spans.
---

# Deno

Deno has built-in OpenTelemetry support. Configure Deno's OTLP exporter to point at Logfire, then optionally use the `logfire` package for manual spans and logs.

## Runtime Export

```bash
OTEL_DENO=true \
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://logfire-api.pydantic.dev/v1/traces \
OTEL_EXPORTER_OTLP_HEADERS='Authorization=your-write-token' \
deno run --unstable-otel --allow-net main.ts
```

## Manual API

When OpenTelemetry is configured, you can use the core package:

```ts
import * as logfire from 'npm:logfire'

await logfire.span('deno task', {
  attributes: { runtime: 'deno' },
  callback: async () => {
    logfire.info('running deno task')
  },
})
```

See `examples/deno-project` for a minimal example.
