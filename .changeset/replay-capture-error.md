---
'@pydantic/logfire-session-replay': minor
---

Let a handled error promote an error-buffered replay. `replay.captureError(error)` adds the error to the replay and promotes the buffer, as an uncaught error does. An error object is added once, even when it is captured and later also uncaught. `captureError(error, { timestamp })` records when an error that is captured later occurred. `captureGlobalErrors: false` removes the replay's own `error` and `unhandledrejection` listeners for integrations that capture global errors themselves, as `@pydantic/logfire-browser` now does. An error event in the replay no longer serializes an object value, such as an object passed to `captureError()` or a rejected object, because replay custom events are not masked; it records only the value's type, such as `[object Object]`.
