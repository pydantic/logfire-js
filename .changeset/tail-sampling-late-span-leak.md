---
'logfire': patch
---

Stop `TailSamplingProcessor` exporting spans that end after the root of a trace the sampler dropped. Trace state was released as soon as the root ended, so any span still running fell through to the unbuffered path and was exported unconditionally. State is now kept until the root has ended and every started span has ended, which also means a late span in a sampled trace still reaches the deferred processor rather than only the wrapped one.
