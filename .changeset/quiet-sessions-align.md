---
'@pydantic/logfire-browser': patch
---

Stop emitting the duplicate `browser.session.id` span attribute. Browser spans and session replays continue to correlate through `session.id`.
