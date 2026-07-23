---
'@pydantic/otel-cf-workers': minor
'@pydantic/logfire-cf-workers': patch
'@pydantic/logfire-node': patch
---

Send a `logfire-js/<version>` User-Agent when exporting traces, logs, and metrics. The Cloudflare Workers OTLP exporter now sends a default `otel-cf-workers/<version>` identifier and accepts a `userAgent` option that is prepended to it.
