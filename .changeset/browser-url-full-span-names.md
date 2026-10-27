---
'@pydantic/logfire-browser': patch
---

Add the URL path to fetch and XHR span names again with current OpenTelemetry instrumentations. Since `@opentelemetry/instrumentation-fetch` and `instrumentation-xml-http-request` 0.221, these spans have `url.full` instead of `http.url`, so a fresh install named them only by method, for example `GET` instead of `GET /api/thing`. The span processor now reads `url.full` first and falls back to `http.url`.
