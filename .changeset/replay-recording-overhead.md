---
'@pydantic/logfire-session-replay': patch
---

Reduce session replay recording overhead by omitting nonvisual DOM metadata and
sampling pointer and scroll activity less frequently.
