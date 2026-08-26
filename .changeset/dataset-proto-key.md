---
'logfire': patch
---

Keep an own `__proto__` key when normalizing values for `pushEvaluationDataset`. Assigning into a plain object invoked the `__proto__` setter instead of creating a property, so a JSON-parsed case value carrying that key had it silently dropped from the pushed dataset.
