---
'@pydantic/logfire-browser': patch
---

Stop reporting a time to first byte of `0` for soft navigations. With `rum.webVitals.reportSoftNavs` on, the `web-vitals` library emits a placeholder TTFB of `0` for each soft navigation, because a route change inside a single-page application has no document request to time. The SDK recorded that placeholder as a `web_vital.ttfb` span and as a `logfire.browser.web_vital.ttfb` histogram point, so every TTFB average or percentile that did not exclude `web_vital.navigation_type = 'soft-navigation'` read lower than the real value.

**Behavior change:** this affects only applications that set `reportSoftNavs: true`. They now get no `web_vital.ttfb` span and no TTFB histogram point for a soft navigation, so the number of TTFB records drops and TTFB averages and percentiles no longer include those `0` readings. A query that already excludes soft navigations returns the same result. Data recorded by earlier versions keeps the `0` readings, so keep that filter for time ranges that include them. LCP, INP, CLS, and FCP are still reported for soft navigations.
