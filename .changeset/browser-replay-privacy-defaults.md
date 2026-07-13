---
'@pydantic/logfire-browser': patch
'@pydantic/logfire-session-replay': patch
---

Use privacy-safe browser defaults: omit query strings and fragments from page
attributes and replay URLs, mask rendered replay text, and disable replay
console capture unless explicitly enabled.
