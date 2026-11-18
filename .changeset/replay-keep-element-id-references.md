---
'@pydantic/logfire-session-replay': patch
---

Keep same-document element references such as SVG `<use href="#icon">` and `<a href="#section">` in replays, so inline SVG sprite icons no longer render blank under the default URL redaction. Fragments that look like hash routes or parameters, such as `#/reset?token=...`, are still removed.
