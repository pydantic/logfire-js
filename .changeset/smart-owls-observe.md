---
'@pydantic/logfire-browser': minor
'@pydantic/logfire-session-replay': patch
---

Add `configureFrontend()` to configure browser tracing, Web Vitals metrics, and optional session replay with one restricted token and regional URL. Auto-instrumentation and Web Vitals metrics are enabled by default, with capture options remaining customizable. The optional replay package now provides `sessionReplayIntegration()` to lazy-load the recorder without requiring applications to write their own dynamic import.
