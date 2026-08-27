---
'logfire': patch
---

Count a score, metric or label named `__proto__`, and a label value of `__proto__`, in report averages. Those names come from evaluator output and were assigned into plain objects, so the inherited setter swallowed them: the bucket disappeared and the remaining label values were renormalised as if it had never existed, reporting 100% for a label that held half the cases.
