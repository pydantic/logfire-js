---
'logfire': patch
---

Count a score, metric or label named `__proto__`, and a label value of `__proto__`, in report averages. Those names come from evaluator output and were assigned into plain objects, so the inherited `__proto__` setter swallowed them: the bucket disappeared and the remaining label values were renormalised as if it had never existed. The aggregation code now tallies through a shared `Map`-backed accumulator, so every key is stored as an own property.
