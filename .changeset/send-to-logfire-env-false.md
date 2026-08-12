---
'logfire': patch
---

Honour `LOGFIRE_SEND_TO_LOGFIRE=false`. The environment variable arrives as a string and was passed to `Boolean()`, and `Boolean('false')` is `true`, so the documented way to turn sending off left it on. Setting `sendToLogfire: false` in code was unaffected. `true`, `false` and `if-token-present` are now normalized once and matched explicitly, case-insensitively and trimmed, so a differently cased sentinel no longer falls through to truthiness either.
