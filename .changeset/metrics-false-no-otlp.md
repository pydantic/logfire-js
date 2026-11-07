---
'@pydantic/logfire-node': patch
---

`metrics: false` no longer leaves the OpenTelemetry NodeSDK to build an OTLP metric reader from `OTEL_METRICS_EXPORTER`, which sent metrics to `localhost:4318` and could stall `shutdown()` for seconds.
