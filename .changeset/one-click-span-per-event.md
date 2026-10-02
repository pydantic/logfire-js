---
'@pydantic/logfire-browser': patch
---

A click now exports one span, not one span for each event listener that the click reaches. Without Zone.js, the OpenTelemetry user interaction instrumentation started a new click span for every listener and parented it to the span of the previous listener. A single click on a page with many listeners became a deep chain of identical click spans. The automatic user interaction instrumentation now keeps the first span for each event. Every later listener runs in the context of that span, so the spans and requests that a listener starts are still its children. The click span ends when the first listener returns, so its duration does not include the time of later listeners. A user interaction instrumentation that you pass through `instrumentations` keeps the upstream behavior.
