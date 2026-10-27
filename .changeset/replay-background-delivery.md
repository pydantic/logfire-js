---
'@pydantic/logfire-session-replay': patch
'@pydantic/logfire-browser': patch
---

Serialize and retry hidden-tab replay uploads in keepalive-sized chunks, pack page-close chunks into the keepalive budget by compressed size, and export structured replay upload failures through the browser SDK.
