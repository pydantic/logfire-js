---
'@pydantic/logfire-api': patch
---

Fix tail sampling duration for span end events. `TailSamplingSpanInfo.duration` was computed from the span's start time even when the span was ending, so a trace whose slowness happened inside the ending span (for example a root span with no later children) never crossed `durationThreshold` and was dropped. End events now use the span's end time, matching Python Logfire's behavior.
