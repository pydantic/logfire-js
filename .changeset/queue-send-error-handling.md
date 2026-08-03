---
'@pydantic/otel-cf-workers': patch
---

End the queue producer span when a send rejects, and record the error on it. `instrumentQueueSend` and `instrumentQueueSendBatch` called `span.end()` only after the wrapped call resolved, so a failed `queue.send()` or `queue.sendBatch()` left the span unended and it was never exported, dropping the operation from the trace and hiding the failure. Both now record the exception, set the span status to `ERROR`, and end the span in a `finally` block, matching the queue consumer handler in the same file and the other Cloudflare instrumentations.
