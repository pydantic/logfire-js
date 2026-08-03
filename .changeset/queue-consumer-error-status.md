---
'@pydantic/otel-cf-workers': patch
---

Set the span status to `ERROR` when a queue consumer handler throws. The handler recorded the exception on its span but left the status `UNSET`, so a failed queue batch did not read as failed and was missed by error filters, unlike the fetch, alarm, and email handlers which already set it.
