---
'@pydantic/logfire-node': minor
---

Keep telemetry running while an application's `SIGTERM` handler drains work. When the application has its own `SIGTERM` listener, the SDK's listener now flushes instead of shutting the SDK down, so spans the handler records after waiting for timers or I/O are exported. The application owns shutdown: call `shutdown()` at the end of the handler before `process.exit()`, or let the event loop empty so `beforeExit` shuts the SDK down. When the SDK's listener is the only one, it still shuts down and re-emits the signal.
