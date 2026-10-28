---
'@pydantic/logfire-node': patch
'logfire': patch
---

Require dependency versions that are free of known security advisories. `@pydantic/logfire-node` now needs `@opentelemetry/auto-instrumentations-node` 0.79.0 or later, because earlier releases bundle database instrumentations that record the database username in `db.user` on every span (GHSA for pg, mysql, mysql2, knex, mongoose, tedious, oracledb, and cassandra-driver). `logfire` now needs `handlebars` 4.7.10 or later, so dependency scanners no longer flag the 4.7.9 advisories.
