---
'@pydantic/logfire-browser': minor
---

Attach the application's current user to browser spans through `rum.session.getUser`, and use the same live id for session replay when no explicit replay identity getter is configured. User context remains client asserted, span-only, and outside persisted browser-session state and Web Vitals metric labels.
