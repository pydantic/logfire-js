---
'@pydantic/logfire-browser': patch
---

Recover trace requests cancelled by quick same-origin navigation. The browser SDK now keeps scrubbed, unacknowledged requests in sessionStorage and retries them from the next instrumented document, preserving the original span IDs and timestamps. This includes requests already in flight before document hide.

Retention is bounded to 32 requests, 2 MiB, and five minutes, and excludes request headers and credentials. Recovery is isolated by endpoint and configured headers. Use `tracePersistence: false` to disable it, or set `tracePersistence.key` to isolate proxy destinations selected by cookies or other state. Recovery is best effort; a lost acknowledgment can cause duplicate delivery.
