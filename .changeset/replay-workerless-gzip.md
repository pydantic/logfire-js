---
"@pydantic/logfire-session-replay": patch
---

Compress replay uploads without blob workers so recording works under enforced Trusted Types. Use native gzip streams when available, with synchronous gzip for older browsers, compression failures, and page-exit uploads.
