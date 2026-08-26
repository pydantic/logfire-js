---
'logfire': patch
---

Record the failure on the span when a zone.js-style thenable's `then` throws before any settlement handler runs, instead of ending the span with an OK status.
