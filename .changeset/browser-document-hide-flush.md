---
'@pydantic/logfire-browser': minor
---

Export the newest spans first when the document hides, in one request small enough to outlive a navigation. The document-hide flush now listens for `visibilitychange` on `window`, so a span that an application ends in its own `document` listener is part of the flush whenever that listener registered, and for `pagehide` on `window`, where the event is dispatched. `batchSpanProcessorConfig.documentHideKeepaliveBytes` sets the size of the first request.
