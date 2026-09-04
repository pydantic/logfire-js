---
'@pydantic/otel-cf-workers': patch
'@pydantic/logfire-cf-workers': patch
---

Keep a span attribute named like an `Object.prototype` member. The Workers span stored attributes by plain assignment, so `setAttribute('__proto__', …)` silently dropped a primitive value and replaced the attribute record's prototype for an array value; the Logfire post-processor then lost the same key again through `Object.assign`. Both now write own properties.
