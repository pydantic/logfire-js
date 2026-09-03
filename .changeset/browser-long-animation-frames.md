---
'@pydantic/logfire-browser': minor
---

Report severe browser main-thread congestion with opt-in, sampled Long Animation Frame spans. The browser SDK now emits bounded per-frame diagnostics and foreground window summaries with normalized script attribution, and existing INP spans include the culprit script already identified by `web-vitals`. The new data remains span-only and is not added to metrics.
