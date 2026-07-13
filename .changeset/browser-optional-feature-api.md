---
'@pydantic/logfire-browser': patch
'@pydantic/logfire-session-replay': patch
---

Preserve callable browser cleanup while exposing generation-scoped session replay lifecycle controls, keep Web Vitals spans available when metrics startup fails, and mark Web Vitals point events as Logfire logs.

Remove unused pre-stable replay transport, recorder snapshot, and navigation `load` surfaces that were never used or emitted.
