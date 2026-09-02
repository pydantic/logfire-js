---
'@pydantic/logfire-browser': patch
---

Report an instrumentation `unregister` that throws `undefined` instead of resolving cleanup as if it had succeeded. The accumulator held the raw thrown value and treated it as the failure sentinel, so `undefined` read as no failure at all, and a first `null` was overwritten by a later error through `??=`. Failures are now normalized to an `Error` when captured, the way the other two error accumulators in that file already do.
