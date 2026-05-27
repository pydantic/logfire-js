---
'@pydantic/logfire-node': patch
---

Improve Node lifecycle flushing so `forceFlush()` and `shutdown()` cover all Logfire-managed span, log, evaluation, metric-reader, and additional span processor paths.
