---
'logfire': minor
---

Expose OpenTelemetry `SpanKind` in the manual span APIs. `span()`, `startSpan()`, `startPendingSpan()`, and `instrument()` accept an optional `kind` that is forwarded to the tracer, and pending span placeholders keep the kind of their real span. Omitting `kind` continues to produce `INTERNAL` spans.
