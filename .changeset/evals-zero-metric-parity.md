---
'logfire': patch
---

Stop recording zero-valued eval metrics that pydantic-evals omits. Span-tree metric extraction now goes through the same increment path as `incrementEvalMetric`, so a provider reporting `gen_ai.usage.cached_tokens: 0` no longer invents a `cached_tokens: 0` metric on the case.
