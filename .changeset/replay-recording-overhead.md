---
'@pydantic/logfire-session-replay': patch
---

Reduce session replay recording and upload overhead by slowing background event
uploads after user inactivity, omitting nonvisual DOM metadata, and sampling
pointer and scroll activity less frequently. Do not upload replay sessions that
rotate during inactivity unless an error or later user interaction makes them
useful. Use the dedicated `@rrweb/record` package for recording.
