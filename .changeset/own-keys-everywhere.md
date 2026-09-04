---
'logfire': patch
---

Handle names that collide with `Object.prototype` members everywhere user-controlled keys meet plain records. A variable, label, rollout weight, or attribute named `__proto__` was silently dropped by the store, the config normalizer, the push API, and the attribute scrubber; a lookup of an unconfigured name such as `constructor` or `valueOf` found the inherited member and misreported the resolution. Records are now built through Maps or `Object.fromEntries` and read with own-property lookups throughout the variables runtime and attribute serialization.
