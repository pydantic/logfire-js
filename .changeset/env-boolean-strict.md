---
'logfire': patch
'@pydantic/logfire-node': patch
---

Reject an environment value that is neither a recognised boolean nor, for `LOGFIRE_SEND_TO_LOGFIRE`, the `if-token-present` sentinel, instead of guessing. `LOGFIRE_DISTRIBUTED_TRACING=yes` silently turned distributed tracing off and `LOGFIRE_CONSOLE=on` silently turned the console off, because anything unrecognised fell through to false; `LOGFIRE_SEND_TO_LOGFIRE=yes` fell through to `Boolean()` and turned sending on. All three now fail with the variable name and the value, matching `_check_bool` in the Python SDK. Unset and blank values keep their current meaning.
