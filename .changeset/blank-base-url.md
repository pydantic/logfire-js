---
'logfire': patch
'@pydantic/logfire-node': patch
---

Treat a blank `LOGFIRE_BASE_URL` as unset, so the base URL falls back to local credentials or the token's region instead of becoming empty
