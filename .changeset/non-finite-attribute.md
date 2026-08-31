---
'logfire': patch
---

Send a non-finite numeric attribute as a string. `NaN`, `Infinity` and `-Infinity` were passed through as OTLP doubles, and since JSON has no spelling for them they serialized to `null`, so the value was lost. They are now sent the way the message template already renders them, matching the Python SDK's `prepare_otlp_attribute`.
