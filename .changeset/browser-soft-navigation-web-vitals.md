---
'@pydantic/logfire-browser': minor
---

Report Web Vitals separately for supported browser-detected soft navigations when `rum.webVitals.reportSoftNavs` is enabled. Web Vital spans now use navigation-time URL context, omit callback-time routes when that historical URL is available, and include navigation identity fields. Optional metrics separate soft-navigation samples with a bounded navigation-type dimension.
