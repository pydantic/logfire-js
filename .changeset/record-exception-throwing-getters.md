---
'logfire': patch
---

Keep `reportError` and `span` from throwing when an error's `message`, `name` or `stack` getter throws, so the span still ends with an error status and the original error is rethrown.
