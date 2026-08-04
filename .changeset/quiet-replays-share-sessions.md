---
'@pydantic/logfire-browser': patch
'@pydantic/logfire-session-replay': minor
---

Remove the experimental `getTraceContext` option and `meta.traceIds` chunk field. Correlate recordings with browser spans through their shared browser session id and replay time bounds.
