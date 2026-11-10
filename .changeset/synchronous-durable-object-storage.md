---
'@pydantic/otel-cf-workers': patch
---

Preserve synchronous return values and exceptions from Durable Object storage methods such as `transactionSync`, while retaining span completion and error recording for asynchronous methods.
