---
'@pydantic/logfire-cf-workers': patch
---

Omit `deployment.environment.name` when the `LOGFIRE_ENVIRONMENT` binding is declared without a value, instead of recording an empty environment on every span.
