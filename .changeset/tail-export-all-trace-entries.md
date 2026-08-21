---
'@pydantic/logfire-cf-workers': patch
---

Export every trace payload in a tail batch. `exportTailEventsToLogfire` stopped at the first entry carrying `resourceSpans`, so a tail worker receiving a batch of producing invocations forwarded only one of them and dropped the rest with no warning. The payloads are now merged into a single OTLP request, which takes `resourceSpans` as a repeated field.
