---
'@pydantic/logfire-ai-sdk-code-mode': minor
---

Add `withCodeMode()`, so a `ToolLoopAgent` can be defined once and still give each `generate()` or `stream()` call its own sandbox session, closed when the call ends.
