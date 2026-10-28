---
'@pydantic/logfire-browser': minor
---

Send the newest spans first when an application calls `forceFlush()`, like the document-hide flush does. `forceFlush()` now sends the newest spans in a small keepalive request and the older spans in a second request started at the same time. Before, it sent the whole buffer in one request. Once a page has loaded, that request is too large for `keepalive`, so an unload soon after could cancel it, together with the record the application flushed it for. An application can now call `forceFlush()` after the end of a page-load measurement, not only after its start. `batchSpanProcessorConfig.documentHideKeepaliveBytes` sets the size of the first request for both flushes.

Both flushes now split only when the trace exporter has two free request slots, and otherwise send one request. Before, a document-hide flush with only one free slot, for example with `traceExporterConfig.concurrencyLimit: 1`, lost its older spans, because the exporter rejected the second request.
