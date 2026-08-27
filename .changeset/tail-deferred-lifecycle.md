---
'logfire': patch
---

Forward `forceFlush` and `shutdown` from `TailSamplingProcessor` to its deferred processor. The processor owns that instance, so nothing else flushes or shuts it down, and it was left running at shutdown.
