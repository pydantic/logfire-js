---
'@pydantic/logfire-node': patch
---

Report every failing flush pipeline from `forceFlush()` instead of only the first. The span processors, log record processors and metric readers were awaited with `Promise.all`, which rejects on the first failure, so a second failing pipeline went unreported and its rejection was left unhandled. Multiple failures are now raised together as an `AggregateError`, matching how `shutdown()` already reports its teardowns.
