---
'@pydantic/logfire-cf-workers': patch
---

Omit `deployment.environment.name` when the resolved environment is empty, instead of recording an empty environment on every span. This covers both a `LOGFIRE_ENVIRONMENT` binding declared without a value and an explicit `environment: ''` passed to `instrumentInProcess`.
