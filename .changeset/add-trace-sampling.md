---
"logfire": minor
"@pydantic/logfire-browser": minor
"@pydantic/logfire-node": minor
---

Add trace sampling support (head + tail)

Implements a two-layer sampling system matching the Python SDK:

- Head sampling: probabilistic sampling at trace creation via `ParentBasedSampler`
- Tail sampling: callback-based sampling with span buffering via `TailSamplingProcessor`
- `SamplingOptions` type, `SpanLevel` class, `checkTraceIdRatio`, and `levelOrDuration` factory in `logfire-api`
- `LOGFIRE_TRACE_SAMPLE_RATE` env var support in `logfire-node`
