---
'@pydantic/logfire-browser': minor
---

Give Web Vital targets a stable name with a `data-logfire-component` attribute. The SDK reports the element behind LCP, INP, and the largest layout shift (`web_vital.lcp.target`, `web_vital.inp.target`, `web_vital.cls.largest_shift_target`) as the CSS selector that `web-vitals` generates. That selector holds class names and generated ids, such as `#:r1:>span`, so the same element gets a different value between builds and page views and does not group. An element that has the attribute, or is inside an element that has it, is now reported as `component:<name>`, for example `component:MessageList`.

**Behavior change:** none until an application adds the attribute. An element with no named ancestor keeps the same CSS selector as before, and an application that passes its own `rum.webVitals.generateTarget` is not affected, because that function replaces the default naming. After an application adds the attribute, new records for the named elements hold `component:<name>` and not a selector, so they no longer match the selectors stored earlier for those elements. To keep CSS selectors for every element, pass `generateTarget: () => undefined`.
