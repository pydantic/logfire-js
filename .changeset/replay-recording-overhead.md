---
'@pydantic/logfire-session-replay': patch
---

Reduce session replay recording and upload overhead by slowing background event
uploads after user inactivity, omitting nonvisual DOM metadata, and sampling
pointer and scroll activity less frequently.
