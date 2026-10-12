---
'@pydantic/logfire-browser': patch
---

Keep each page's route on its Web Vitals when the application navigates before anything else observed that page. The SDK learned a page's route only when a span started or a Web Vital reported while its URL was current, so an early client-side navigation, or a quick second one, left Web Vitals without `logfire.page.route`. `configure()` now records the initial page and its route when Web Vitals are enabled, and with `reportSoftNavs` it also records each page the application navigates to, in browsers with the Navigation API (all browsers that report soft navigations).
