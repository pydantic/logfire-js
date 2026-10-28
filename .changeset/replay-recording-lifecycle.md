---
'@pydantic/logfire-session-replay': minor
'@pydantic/logfire-browser': patch
---

Stop session replay when uploads can no longer succeed, and link spans only to replays that exist.

- After a `4xx` rejection that every later chunk would also get (other than `408`, `413`, `425`, and `429`), such as a revoked token or a usage block (`401`, `402`, `403`), replay stops and detaches the recorder. Before, each tab serialized a full DOM snapshot for another rejected upload about once a minute until it closed.
- Browser replay now follows the RUM session's idle timeout, so a tab that goes idle starts a new replay with its new RUM session.
- The replay handle has a new `uploading` getter. The browser SDK marks spans with `logfire.session_replay.mode: 'full'` only once the recording passes its minimum duration and uploads, so visits that end earlier no longer point at replays that were never uploaded.
