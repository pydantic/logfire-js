---
title: Environment Variables
description: Environment variables used by the Logfire TypeScript SDK packages.
---

# Environment Variables

## Node.js

`@pydantic/logfire-node` reads these variables:

| Variable                      | Purpose                                                                  |
| ----------------------------- | ------------------------------------------------------------------------ |
| `LOGFIRE_TOKEN`               | Write token used to send traces, metrics, and logs to Logfire.           |
| `LOGFIRE_API_KEY`             | API key for platform APIs such as remote managed variables.              |
| `LOGFIRE_SERVICE_NAME`        | Service name resource metadata.                                          |
| `LOGFIRE_SERVICE_VERSION`     | Service version resource metadata.                                       |
| `LOGFIRE_ENVIRONMENT`         | Deployment environment resource metadata.                                |
| `LOGFIRE_CONSOLE`             | Set to `true` to also print spans to the console.                        |
| `LOGFIRE_SEND_TO_LOGFIRE`     | Set sending behavior. `if-token-present` sends only when a token exists. |
| `LOGFIRE_DISTRIBUTED_TRACING` | Set to `false` to suppress extraction of incoming trace context.         |
| `LOGFIRE_TRACE_SAMPLE_RATE`   | Head sampling rate from `0` to `1`.                                      |
| `LOGFIRE_BASE_URL`            | Override the Logfire API base URL.                                       |

## Cloudflare Workers

`@pydantic/logfire-cf-workers` reads Worker environment values:

| Variable              | Purpose                                  |
| --------------------- | ---------------------------------------- |
| `LOGFIRE_TOKEN`       | Write token used by the Worker exporter. |
| `LOGFIRE_ENVIRONMENT` | Deployment environment metadata.         |
| `LOGFIRE_BASE_URL`    | Override the Logfire API base URL.       |

Store production values as Worker secrets.

## Browser

`@pydantic/logfire-browser` does not read Logfire credentials from environment variables. Configure a `traceUrl` that points at your backend proxy.

## Generic OpenTelemetry

Platforms such as Deno and Vercel's OpenTelemetry integration use standard OTLP environment variables:

| Variable                              | Purpose                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`         | Base OTLP endpoint, such as `https://logfire-api.pydantic.dev`.         |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`  | Trace endpoint, such as `https://logfire-api.pydantic.dev/v1/traces`.   |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Metric endpoint, such as `https://logfire-api.pydantic.dev/v1/metrics`. |
| `OTEL_EXPORTER_OTLP_HEADERS`          | Headers for OTLP export, including `Authorization=your-write-token`.    |
