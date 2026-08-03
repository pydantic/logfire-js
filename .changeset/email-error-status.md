---
'@pydantic/otel-cf-workers': patch
---

Set the span status to `ERROR` when an email handler throws. The handler recorded the exception on its span but left the status `UNSET`, so a failed email invocation did not read as failed and was missed by error filters, unlike the fetch, alarm, and Durable Object handlers which already set it.
