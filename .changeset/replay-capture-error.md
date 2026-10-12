---
'@pydantic/logfire-session-replay': minor
---

Let a handled error promote an error-buffered replay. `replay.captureError(error)` adds the error to the replay and promotes the buffer, as an uncaught error does. An error object is added once, even when it is captured and later also uncaught. `captureGlobalErrors: false` removes the replay's own `error` and `unhandledrejection` listeners for integrations that capture global errors themselves, as `@pydantic/logfire-browser` now does.
