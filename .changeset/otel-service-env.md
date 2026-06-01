---
'@pydantic/logfire-node': patch
---

Read `OTEL_SERVICE_NAME` and `OTEL_SERVICE_VERSION` as Node service metadata fallbacks when the corresponding `LOGFIRE_*`
environment variables are unset.
