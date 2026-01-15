---
"@pydantic/logfire-node": patch
---

Fix OpenTelemetry peer dependency conflict by upgrading to 0.210.x versions

The previous configuration declared `@opentelemetry/auto-instrumentations-node@^0.67.0` alongside `@opentelemetry/sdk-node@^0.209.0`, which are incompatible because auto-instrumentations-node@0.67.x requires sdk-node@^0.208.0 internally. Updated all conflicting peer dependencies to 0.210.x to align with auto-instrumentations-node@0.68.0.
