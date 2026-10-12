---
'@pydantic/logfire-browser': minor
'@pydantic/logfire-session-replay': minor
---

Rotate browser and standalone replay session IDs after two hours of active recording by default, instead of four hours. Browser telemetry and integrated replay keep the same session ID when they rotate.

Applications that configure a custom maximum duration retain that setting.
