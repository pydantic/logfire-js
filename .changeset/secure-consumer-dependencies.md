---
'logfire': patch
'@pydantic/logfire-node': patch
---

Require `js-yaml` 4.3.0 and `@opentelemetry/sdk-node` 0.220.0 or newer to ensure consumers resolve patched YAML merge handling and Jaeger propagation dependencies.
