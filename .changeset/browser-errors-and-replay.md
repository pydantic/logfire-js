---
'@pydantic/logfire-browser': minor
---

Report browser errors and keep the replays around them without application-owned listeners or a custom sampler.

- `configure()` and `configureFrontend()` now report uncaught errors and unhandled promise rejections as error-level spans named `Uncaught error` and `Unhandled promise rejection`. Resource load failures are not reported. An error object that the application already reported, for example before rethrowing it or from its own `window` `error` listener, is reported once. Pass `captureGlobalErrors: false` to turn global capture off.
- Every `reportError()` call now adds the error to an active session replay and promotes an error-buffered replay, so a handled error gets a replay, not only an uncaught one. The browser SDK turns off the replay package's own global error listeners, so an uncaught error appears in the replay once.
- `configureFrontend({ profile: 'errors' })` sets defaults for errors and replay without performance data: it exports only traces with an error-level span, an error status, or an HTTP 5xx response; turns off Web Vitals, their metrics, and document-load spans; and records replay only for sessions with an error. Options passed explicitly take precedence.
- The automatic click span now ends when the last listener for the click returns, or throws, instead of when the first one returns. The first listener is often a library's capture listener, such as the replay recorder's, so the span ended before the application's handler ran, and tail sampling decided the trace without the handler's work. A click whose first listener threw also never ended its span.
