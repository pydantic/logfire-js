---
'@pydantic/logfire-browser': minor
---

Add `rum.webVitals.stableSelectors`, and keep the CSS selector of a Web Vital target that has a component name.

`web-vitals` ends the selector of a target at the first element that has an id. When a framework generates that id at render time, such as a React `useId` id (`:r1:`, `«r1»`, `_r_1_`) or a library id built on one (`radix-:r1:`), the selector is different on each page view and does not group. With `stableSelectors: true`, the SDK treats an element with a generated id as an element with no id, so `#:r1:>span` becomes `#app>div.card>span`. The documentation lists the detected ids and the limits.

A target that is reported as `component:<name>` now also has its CSS selector in `web_vital.lcp.target_selector`, `web_vital.inp.target_selector`, or `web_vital.cls.largest_shift_target_selector`.

**Behavior change:** none for the target attributes until an application sets `stableSelectors: true`. With the option on, a selector that held a generated id is replaced by a selector without it, so new records for those elements no longer match the selectors stored earlier. A selector with no generated id in it stays the same, character for character. A hand-written id that looks generated is also left out: one that holds a React-style token, such as `tab-:r2:`, or one that starts with `radix`, `headlessui`, or `react-aria` and ends with a number, such as `radix-demo-2`. The `target_selector` attributes are new and appear only on records whose target is a `data-logfire-component` name; an application that passes its own `rum.webVitals.generateTarget` gets none.
