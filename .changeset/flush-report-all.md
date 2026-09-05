---
'@pydantic/logfire-node': patch
---

Report every failing flush pipeline from `forceFlush()` instead of only the first. The span processors, log record processors and metric readers were awaited with `Promise.all`, which rejects with the first failure and never surfaces the rest, so a second failing pipeline went unreported. Multiple failures are now raised together as an `AggregateError`, matching how `shutdown()` already reports its teardowns.
