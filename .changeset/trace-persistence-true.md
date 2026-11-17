---
'@pydantic/logfire-browser': minor
---

Accept `tracePersistence: true` to turn on trace recovery with default settings. An empty options object (`{}`) was the only way to turn it on, and it did not read as an opt-in. `{}` and `{ key }` still work.
