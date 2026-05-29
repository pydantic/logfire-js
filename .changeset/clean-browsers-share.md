---
'@pydantic/logfire-browser': patch
---

Make Browser cleanup safe to call repeatedly by sharing one cleanup promise, preserving cleanup order, and avoiding hidden retries after failure.
