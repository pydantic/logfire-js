---
'@pydantic/logfire-node': patch
---

Accept the boolean environment variable spellings the Python SDK accepts. `LOGFIRE_DISTRIBUTED_TRACING=TRUE` previously matched neither branch and disabled distributed tracing, and `LOGFIRE_CONSOLE` only recognised a lowercase, untrimmed `true`.
