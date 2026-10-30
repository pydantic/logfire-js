---
'@pydantic/logfire-session-replay': minor
'@pydantic/logfire-browser': patch
---

Record one session in ten by default instead of every session, so replay usage and the privacy exposure stay proportionate when a rate is not chosen.

- **Behavior change:** `sessionSampleRate` now defaults to `0.1` (was `1`). `onErrorSampleRate` stays `1`, so every other session is buffered and uploaded if an error occurs. Before, the error buffer never applied, because every session was already recorded in full. To keep recording every session, set `sessionSampleRate: 1`.
- The replay docs now recommend a rate for each traffic level and show how to record every session in development.
