---
'@pydantic/logfire-browser': minor
'@pydantic/logfire-session-replay': patch
---

Add `createFrontendApplicationConfig()` so browser tracing, Web Vitals metrics, and optional session replay share one restricted token and regional URL. The optional replay package now provides `sessionReplayIntegration()` to lazy-load the recorder without requiring applications to write their own dynamic import.
