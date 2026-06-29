---
'@pydantic/logfire-browser': minor
---

Add opt-in native OpenTelemetry histogram metrics for browser Web Vitals. Configure top-level `metrics.metricUrl` and `rum.webVitals.metrics` to emit LCP, INP, CLS, FCP, and TTFB metrics in parallel with existing Web Vital spans.
