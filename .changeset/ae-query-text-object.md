---
'@pydantic/otel-cf-workers': patch
---

Stop writing `writeDataPoint [object Object]` to `db.query.text` on Analytics Engine spans. A data point write has no query text, and its contents are already summarised by the `db.cf.ae.*` attributes.
