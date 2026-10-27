---
'@pydantic/otel-cf-workers': patch
---

Stop `parseConfig` from mutating the supplied trace config. Reusing one config object across requests with a different exporter each time now exports each request to its own exporter instead of the first request's.
