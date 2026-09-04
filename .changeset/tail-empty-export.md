---
'@pydantic/logfire-cf-workers': patch
---

Stop writing an empty trace payload from the tail-worker exporter. Shutdown serialized a batch of zero spans, which produced `{"resourceSpans":[]}` in the log stream, and the tail worker forwards the first logged object carrying `resourceSpans`, so an empty export could be sent in place of the batch's real spans.
