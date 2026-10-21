---
'logfire': patch
'@pydantic/logfire-node': patch
'@pydantic/logfire-browser': patch
'@pydantic/otel-cf-workers': patch
---

Fix fresh installs failing with `ERESOLVE` since the OpenTelemetry JS 3.0 release. The OpenTelemetry dependency ranges now stop before `@opentelemetry/api` 1.10, `@opentelemetry/auto-instrumentations-node` 0.82, `@opentelemetry/auto-instrumentations-web` 0.69 and `@opentelemetry/instrumentation-user-interaction` 0.68, which require the 3.0 line. A new install resolves to the 1.9 / 2.x / 0.2xx line again. Support for OpenTelemetry JS 3.0 will follow in a later release.
