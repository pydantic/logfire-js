---
'logfire': patch
---

Keep `TailSamplingProcessor` trace state until the root has ended and every started span has ended, so a span still running when the root closes is no longer exported unconditionally through the unbuffered path. This is a deliberate divergence from the Python SDK, which pops the buffer at root end and passes late spans through, bounding memory by accepting that behaviour; the upstream side is tracked in pydantic/logfire#2273. Two consequences of the longer lifetime: a late span in a sampled trace now reaches the deferred processor rather than only the wrapped one, and a late span can still flip a trace to sampled after its root ended below a duration threshold, replaying the whole trace. Retention past root end is capped at 1000 traces, after which the oldest degrades to the previous passthrough behaviour rather than pinning memory.
