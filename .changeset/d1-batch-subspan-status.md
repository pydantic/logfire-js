---
'@pydantic/otel-cf-workers': patch
---

Mark the per-statement spans of a D1 batch as errors when the batch fails. `instrumentD1Fn` created one span per query in a `batch()` call but only set `ERROR` on the parent span, so a failed batch showed every query as apparently successful underneath a failed parent. The statement spans now carry the error status too, while the exception itself stays on the parent so it is not duplicated once per statement.
