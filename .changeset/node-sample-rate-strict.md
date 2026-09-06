---
'@pydantic/logfire-node': patch
---

Reject an unreadable `LOGFIRE_TRACE_SAMPLE_RATE` instead of silently exporting every trace.

An unparseable or out-of-range value was discarded and head sampling was left off, so
`LOGFIRE_TRACE_SAMPLE_RATE=10%` exported all traces rather than a tenth, and `-1` exported all of
them when the user had asked for none. `parseFloat` also accepted `0.1x` as `0.1`. The value is now
parsed with `Number` and must be a number from `0` to `1`, matching `parseBooleanEnv` in the same
file and Python's `float()` cast for this parameter.
