---
'@pydantic/otel-cf-workers': patch
---

End the Analytics Engine span when a write rejects, and record the error on it. `instrumentAnalyticsEngineDataset` called `span.end()` only on the success path, so a failed `writeDataPoint` left the span unended and it was never exported, losing the operation from the trace and leaving the failure invisible. It now records the exception, sets the span status to `ERROR`, and ends the span in a `finally` block, matching the other Cloudflare instrumentations.
