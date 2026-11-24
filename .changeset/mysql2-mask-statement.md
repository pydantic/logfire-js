---
'@pydantic/logfire-node': patch
---

Keep mysql2 bound parameter values out of query text by default. `db.query.text` is not scrubbed, and the mysql2 instrumentation can format bound parameter values into it, so secrets passed as parameters could reach Logfire. The mysql2 instrumentation now runs with `maskStatement: true`, which leaves parameters as `?` and also masks quoted strings and numbers written into the SQL on a best-effort basis. Set `maskStatement: false` under `nodeAutoInstrumentations['@opentelemetry/instrumentation-mysql2']` to keep literals.
