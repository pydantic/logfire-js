---
'logfire': patch
---

Honour `LOGFIRE_SEND_TO_LOGFIRE=false`. The environment variable arrives as a string and was passed to `Boolean()`, and `Boolean('false')` is `true`, so the documented way to turn sending off left it on. Setting `sendToLogfire: false` in code was unaffected. The `true` and `false` strings are now read explicitly, case-insensitively and trimmed.
