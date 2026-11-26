---
'logfire': patch
---

Prevent OpenTelemetry baggage from setting reserved online evaluation and Logfire log attributes, while preserving `logfire.variables.*` labels.
