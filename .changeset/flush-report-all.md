---
'@pydantic/logfire-node': patch
---

Report every failing flush pipeline from `forceFlush()` instead of only the first. The span processors, log record processors, and metric readers were awaited with `Promise.all`, which rejects on the first failure and leaves the rest unreported. A lone failure is still rethrown as-is; several are raised together as an `AggregateError`, the way `shutdown()` already reports its teardowns.
