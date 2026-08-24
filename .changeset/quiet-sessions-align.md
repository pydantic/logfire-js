---
'@pydantic/logfire-browser': patch
---

Stop emitting the duplicate `browser.session.id` span attribute. Browser spans and session replays continue to correlate through `session.id`; spans recorded in full or buffer mode retain the `logfire.session_replay.active` and `logfire.session_replay.mode` markers.
