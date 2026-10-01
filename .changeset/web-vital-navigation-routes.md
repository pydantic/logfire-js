---
'@pydantic/logfire-browser': patch
---

Document Web Vital spans now carry `logfire.page.route`. Since soft-navigation support, every document Web Vital had a navigation URL, so the SDK omitted the route from all of them. Page loads and their Web Vitals then grouped differently in route-based views. The SDK now remembers the first route that `getRouteName` returned while each navigation's URL was current, and it stamps that route on Web Vitals for the same navigation, including soft navigations and metrics that report after the user navigates away. When no route was observed for a navigation, the attribute is still omitted.
