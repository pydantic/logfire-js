---
'@pydantic/logfire-browser': patch
---

Stop `LogfireSpanProcessor.onStart` throwing when a span carries an `http.url` that is not an absolute URL. The processor parsed the attribute with `new URL()` while renaming fetch spans, so a relative or non-string value raised `TypeError: Invalid URL` out of `onStart` and broke span creation for the application. Unparseable values now leave the span name unchanged.
