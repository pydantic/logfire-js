---
'logfire': patch
---

Identify the V8 stack header by matching the error's own name and message, so a message containing a frame-shaped `x@y:1:2` no longer leaks into the exception fingerprint as a fake frame.
