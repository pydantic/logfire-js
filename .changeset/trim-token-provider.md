---
'@pydantic/logfire-node': patch
---

Trim whitespace around the value a `token` provider function returns. A trailing newline, such as one left by reading a secret file, made Node reject the `Authorization` header and drop every export.
