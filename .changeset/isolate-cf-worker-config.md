---
'@pydantic/otel-cf-workers': patch
'@pydantic/logfire-cf-workers': patch
---

Send each Cloudflare Worker request's spans to the exporter, resource, and propagator from that request's resolved config. Before, the first request in an isolate fixed these for all later requests. A `ResolveConfigFn` that picked a destination or service name per request or trigger could then send one tenant's telemetry to another tenant's collector. `@pydantic/logfire-cf-workers` reads its config only from `env`, so it was not affected in practice. It now also copies `additionalSpanProcessors` instead of appending the console exporter to the caller's array on every request.
