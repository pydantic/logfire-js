---
'@pydantic/logfire-node': patch
---

Trim whitespace around a string token from `configure({ token })` or `LOGFIRE_TOKEN`. A token with a trailing newline, as secret stores often write it, used to lose its region and fall back to the US endpoint, and its export requests failed with an invalid `Authorization` header.
