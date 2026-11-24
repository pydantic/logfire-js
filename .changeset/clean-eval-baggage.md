---
'logfire': patch
---

Prevent OpenTelemetry baggage keys under `logfire.*` from becoming online evaluation log attributes, while preserving `logfire.variables.*` labels.
