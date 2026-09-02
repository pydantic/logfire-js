---
'logfire': patch
---

Reject a non-positive or fractional `maxConcurrency` on `OnlineEvaluator`. A limit of `0` built a semaphore with no permits, so the evaluator never ran, every attempt was reported as hitting the concurrency limit, and the sink still received a payload with no results. `Dataset.evaluate` already rejects the same value.
