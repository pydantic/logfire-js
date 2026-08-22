---
'@pydantic/logfire-session-replay': patch
---

Reduce session replay recording and upload overhead by slowing background event
uploads to one minute after 30 seconds of inactivity, then five minutes after
five minutes of inactivity. Omit nonvisual DOM metadata and sample pointer and
scroll activity less frequently. Do not upload replay sessions that rotate
during inactivity unless an error or later user interaction makes them useful.
Use the dedicated `@rrweb/record` package for recording.
