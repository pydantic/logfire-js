---
'@pydantic/logfire-node': minor
---

`distributedTracing: false` now ignores all incoming context, including W3C baggage, instead of only trace context. Outgoing requests still carry trace context and baggage. This matches the Python SDK.
