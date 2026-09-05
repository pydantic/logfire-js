---
'@pydantic/logfire-browser': patch
---

Keep a Web Vitals metric attribute whose name is an `Object.prototype` member. Attribute keys come from the `attributes` and `defaultAttributes` callbacks, and a plain record write to a `__proto__` key ran the inherited setter, so that entry was silently dropped from the recorded metric.
