---
'@pydantic/logfire-browser': patch
---

Keep a metric or session attribute whose name is an `Object.prototype` member. A plain record write to a `__proto__` key runs the inherited setter and silently drops the entry; every user-keyed attribute write in the package now defines an own property instead.
