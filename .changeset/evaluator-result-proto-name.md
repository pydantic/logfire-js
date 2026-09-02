---
'logfire': patch
---

Keep an evaluator result whose name collides with `Object.prototype`. The duplicate-name check read the bucket with `existing[name]`, which finds the inherited member, so a result named `toString` or `__proto__` looked like a repeat and was renamed to `toString_2`, and writing a genuine `__proto__` name ran the inherited setter instead of storing the result. The check now uses `Object.hasOwn` and the write defines an own property.
