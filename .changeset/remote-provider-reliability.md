---
"logfire": patch
---

Internal reliability improvements to `LogfireRemoteVariableProvider`:

- SSE reconnects now immediately fetch fresh config to recover changes missed while the stream was down (first connection is unaffected).
- Backoff is only reset by SSE-framed lines (comments or named fields), not by arbitrary bytes, preventing a permanent 1 req/s reconnect loop against misbehaving proxies that return short HTTP error bodies.
- Polling interval uses ±10% uniform jitter to spread load across instances; the freshness guard is adjusted to `0.9 × interval` so jitter-early polls are not silently dropped.
- Variable fetches use `If-None-Match` / `304 Not Modified` when the server sends an `ETag`, skipping body parsing and config replacement on unchanged responses while still advancing the freshness timestamp.
- A single 2s debounced follow-up `refresh` is scheduled after each SSE variable event to coalesce bursts and survive short platform cache lag.
