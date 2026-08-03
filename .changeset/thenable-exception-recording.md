---
'logfire': patch
---

Record the exception on the span when a zone.js style promise returned from a `span()` callback rejects. Native promise rejections already recorded the error and set the span status to `ERROR`, but the zone.js branch only ended the span, so in Angular applications a failing span looked successful and carried no exception.
