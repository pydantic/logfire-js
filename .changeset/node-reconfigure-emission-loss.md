---
"@pydantic/logfire-node": patch
---

Make repeated `configure()` calls — and `configure()` after `shutdown()` — deterministically replace the active SDK. Previously the OpenTelemetry API silently refused the new global registration, so every emission stayed pinned to the first configuration and went dark once it shut down, most visibly under HMR-style dev servers that re-run the entry module (#167). Teardown now unregisters the API globals logfire owns, disables superseded instrumentations, and re-fetches the shared tracer. Also fixed: `shutdown()` and `forceFlush()` no longer hang for 30 seconds when `sendToLogfire` is false and spans are buffered.
