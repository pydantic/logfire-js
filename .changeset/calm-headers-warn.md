---
"@pydantic/logfire-cf-workers": major
"@pydantic/otel-cf-workers": major
---

Stop capturing all Cloudflare Worker request and response headers by default.
Header span attributes now require explicit opt-in through
`captureHeaders.request` and `captureHeaders.response`, using case-insensitive
header name arrays, predicate functions, or `true` when full capture is
intentionally required.
