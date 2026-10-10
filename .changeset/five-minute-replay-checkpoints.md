---
'@pydantic/logfire-session-replay': minor
---

Take full-DOM checkpoints every five minutes during normal recording, or at the configured minimum session duration when longer. Start each checkpoint in a new upload chunk so replay viewers can load and seek through smaller playback windows. Error-buffered recording keeps its existing two-minute checkpoint interval.
