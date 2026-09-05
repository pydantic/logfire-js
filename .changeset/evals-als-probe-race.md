---
'logfire': patch
---

Fix concurrent eval cases sharing one task-run context on the first `Dataset.evaluate` call.

The `AsyncLocalStorage` probe recorded "probe started" in a boolean before awaiting its dynamic
`import('node:async_hooks')`. Every case that began while that import was still in flight saw the
flag already set, skipped the await, and fell through to the no-ALS fallback slot, so
`setEvalAttribute` and `incrementEvalMetric` silently recorded nothing for those cases. The probe
is now cached as a promise that all callers await.
