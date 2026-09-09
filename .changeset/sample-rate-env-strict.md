---
'@pydantic/logfire-node': patch
---

Reject an unreadable `LOGFIRE_TRACE_SAMPLE_RATE` instead of silently exporting everything. A value that failed the parse — `10%`, `-1`, `1.5` — was dropped on the floor, turning head sampling off; `parseFloat` also accepted trailing junk like `0.1x`. `configure()` now throws for anything that does not read as a number between 0 and 1, the same policy the boolean environment variables and the Python SDK already apply. An empty or whitespace-only value is still treated as unset, and an explicit `sampling` option is unaffected by the environment.
