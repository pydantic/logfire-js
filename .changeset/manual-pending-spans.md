---
'logfire': patch
'@pydantic/logfire-browser': patch
'@pydantic/logfire-node': patch
'@pydantic/logfire-cf-workers': patch
---

Add a shared `startPendingSpan()` helper for explicit pending placeholders without enabling automatic Browser pending spans.
