---
'@pydantic/otel-cf-workers': patch
---

Record `http.url` on Cache spans when the key is a string or a `URL`, not just a `Request`. The Cache methods accept `RequestInfo | URL`, but the attribute was read from `argArray[0].url`, which only exists on a `Request`, so `caches.default.match('https://example.com/x')` produced a span with no URL at all. Malformed keys now omit the attribute instead of letting URL parsing throw into the caller.
