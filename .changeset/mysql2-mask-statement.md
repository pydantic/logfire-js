---
'@pydantic/logfire-node': patch
---

Mask literals in mysql2 query text by default. `db.query.text` is not scrubbed, and the mysql2 instrumentation can format bound parameter values into it, so secrets passed as parameters could reach Logfire. The mysql2 instrumentation now runs with `maskStatement: true`, which shows quoted strings and numbers as `?`. Set `maskStatement: false` under `nodeAutoInstrumentations['@opentelemetry/instrumentation-mysql2']` to keep literals.
