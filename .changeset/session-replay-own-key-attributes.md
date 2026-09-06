---
'@pydantic/logfire-session-replay': patch
---

Define session attributes as own properties so a prototype-named key can never run an inherited setter, independent of the key-pattern guard in front of the write.
