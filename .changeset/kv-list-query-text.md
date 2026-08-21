---
'@pydantic/otel-cf-workers': patch
---

Stop writing the literal text `list undefined` to `db.query.text` on KV list spans that have no prefix.
