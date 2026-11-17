---
'@pydantic/logfire-browser': minor
---

Add opt-in recovery for trace requests cancelled by same-origin navigation, including requests already in flight. Set `tracePersistence: {}` to retain scrubbed requests in sessionStorage and retry them from the next instrumented document with their original span IDs and timestamps.

Recovery is disabled by default because lost acknowledgments can cause duplicate delivery, including during ordinary navigation. Retention is bounded to 32 requests, 2 MiB, and five minutes, and excludes request headers and credentials. Recovery requires Web Crypto, Web Locks, and available session storage. It is isolated by endpoint and configured headers; use `tracePersistence.key` to isolate proxy destinations selected by other state. Background retries do not delay forceFlush or take priority over new exports.

The newest chunk sized for keepalive is excluded from recovery to avoid replaying successful unload uploads. That chunk can be lost if keepalive fails or its shared budget is exhausted. Other requests can still be duplicated after an acknowledgment is lost.
