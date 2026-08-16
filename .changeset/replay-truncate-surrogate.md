---
'@pydantic/logfire-session-replay': patch
---

Stop a truncated console argument ending in a lone surrogate. Capture cut arguments on UTF-16 code units, so an astral character straddling the limit kept only its high half, leaving text that is not valid UTF-8 once the replay event is sent. The whole character is dropped instead, and the omitted-character count stays accurate.
