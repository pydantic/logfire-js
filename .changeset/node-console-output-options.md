---
'@pydantic/logfire-node': minor
---

Add Node object-style console output options for minimum level, tags, and timestamps.

`console: true` and `LOGFIRE_CONSOLE=true` now use an `info` console minimum by default. Use `console: { minLevel: 'debug' }`
or `console: { minLevel: 'trace' }` to print lower-severity output locally.
