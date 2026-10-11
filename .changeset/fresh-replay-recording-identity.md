---
'@pydantic/logfire-session-replay': minor
'@pydantic/logfire-browser': minor
---

Give each tab replay an upload/playback ID distinct from its RUM session ID. Preserve it across same-tab reloads and navigations, but start a new replay for another tab or after two hours. Add `getRecordingId()` to the standalone recorder and `logfire.session_replay.id` to browser spans. Start a new replay when its saved sequence cannot be safely resumed.

Requires Platform compatibility readers before upgrading. New tabs produce separate billable replays; same-tab reloads continue the existing replay. The RUM `session.id` attribute and `getSessionId()` remain unchanged; standalone callers linking to playback must use `getRecordingId()`.
