---
'@pydantic/logfire-browser': patch
---

Make same-page browser reconfiguration deterministic and ownership-safe. Cached tracers and manual Logfire APIs now follow each sequential provider generation, inactive intervals are non-recording, overlapping configurations fail explicitly, and cleanup preserves application-owned OpenTelemetry globals.
