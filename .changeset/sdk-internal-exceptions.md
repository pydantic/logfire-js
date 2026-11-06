---
'logfire': minor
'@pydantic/logfire-browser': minor
'@pydantic/logfire-session-replay': minor
---

Let a consumer of browser telemetry separate SDK failures from application errors without matching message text.

Exception spans for errors that `@pydantic/logfire-browser` and `@pydantic/logfire-session-replay` raise about themselves now carry `logfire.sdk.internal = true`, whether the error reaches `reportError()` through global error capture or through the application's `sessionReplay.onError` callback. A failing `span()` or `instrument()` callback that throws such an error is marked too, and so is the `Session replay upload was not confirmed` log. Errors from application code carry no attribute, including an error that an application callback throws into the SDK.
