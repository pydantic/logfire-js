---
'logfire': patch
---

Match OTel's exclusive TraceIdRatioBasedSampler bound in `checkTraceIdRatio`. An accumulation equal to `floor(rate * 0xffffffff)` was sampled; the spec comparison is `<`, so the 0.5 threshold ID `7fffffff` followed by 24 zeros is now dropped.
