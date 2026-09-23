---
'@pydantic/logfire-node': patch
---

Honor `distributedTracing: false`. Incoming `traceparent` headers were still extracted because NodeSDK fell back to its default propagators; they are now ignored, while outgoing requests still carry trace context.
