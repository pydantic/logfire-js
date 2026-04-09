---
"logfire": patch
---

Record exceptions on spans when callbacks throw or reject

`span()` now automatically records exception details (event, ERROR status, log level, fingerprint) when the callback throws synchronously or the returned promise rejects, matching the Python SDK's behavior.
