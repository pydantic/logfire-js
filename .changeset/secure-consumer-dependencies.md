---
'logfire': patch
'@pydantic/logfire-node': patch
---

`logfire` now requires `js-yaml >=4.3.0` so consumers resolve the patched YAML merge-key handling.

`@pydantic/logfire-node` now requires `@opentelemetry/sdk-node >=0.220.0 <0.300.0` so consumers resolve the patched Jaeger propagation dependency while retaining the existing SDK upper bound.
