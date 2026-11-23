---
'@pydantic/otel-cf-workers': minor
'@pydantic/logfire-cf-workers': minor
---

Support Durable Object classes that extend `DurableObject` from `cloudflare:workers` in `instrumentDO()`. These classes previously failed to construct. RPC methods and WebSocket handlers now run with the Logfire configuration active and get their own spans, so `logfire.info()` inside them no longer throws `Config is undefined`. Spans started outside any instrumented handler, such as in a Durable Object class that is not wrapped with `instrumentDO()`, are now dropped with a one-time warning instead of throwing.
