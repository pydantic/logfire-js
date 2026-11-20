---
'@pydantic/logfire-session-replay': patch
---

Trim whitespace around the session replay `token`, whether it is a string or a function. A trailing newline, such as one left by reading a secret file or an environment template, made the browser reject the `Authorization` header and fail every upload. A token that is only whitespace now counts as empty, so a caller's own `Authorization` header is kept.
