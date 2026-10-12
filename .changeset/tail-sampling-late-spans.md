---
'logfire': minor
---

Keep spans of a dropped trace out of the export when they start after the trace was dropped. Tail sampling exported such a span unconditionally, so a healthy trace whose root ended early, such as a click whose handler ran after the click span ended, leaked its later spans. Such a span is now buffered and exported only when it, or a span after it, meets the sampling criteria. `logfireApiConfig.onReportError` is a new hook that receives the original error of every `reportError()` call; the browser SDK uses it to connect reported errors to session replay.
