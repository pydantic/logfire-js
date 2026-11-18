---
'@pydantic/logfire-session-replay': minor
'@pydantic/logfire-browser': minor
---

Let applications start session replay only after the user consents. With `autoStart: false`, replay records, stores, and sends nothing, and keeps no reported errors, until `start()` is called; the browser SDK does not load the replay package before then either (`cleanup.sessionReplay.start()`). `stop({ discard: true })` handles withdrawn consent: it detaches the recorder and drops buffered and queued replay data instead of uploading it. A `stop()` while the replay package is still loading now keeps the recorder from starting at all, where it previously attached and then stopped it.
