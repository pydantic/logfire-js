---
'@pydantic/logfire-session-replay': minor
---

Keep session replays playable after upload failures. Ordinary chunks now wait in a bounded in-memory queue and are retried with the same sequence number and bytes for up to 30 seconds, including after `408`, `425`, `429`, and `5xx` responses. A chunk that is still lost is reported to `onError` as a new `ReplayUploadError` with its `seq`, the `droppedSeqs` that depended on it, and a `reason`. Replay then takes a fresh full snapshot, so later events replay correctly instead of applying to DOM state the server never received. `stop()` now resolves within about 10 seconds, even when uploads hang.
