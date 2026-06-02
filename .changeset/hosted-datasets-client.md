---
'logfire': minor
'@pydantic/logfire-node': minor
---

Add a hosted datasets API client for managing Logfire datasets and cases from trusted JavaScript runtimes.

The core client is available from `logfire/datasets` with explicit API-key configuration. Node.js applications can use `@pydantic/logfire-node/datasets` for a helper that reads `LOGFIRE_API_KEY` and `LOGFIRE_BASE_URL`. High-level local `Dataset` push/fetch integration is separate follow-up work.
