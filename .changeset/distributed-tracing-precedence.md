---
'@pydantic/logfire-node': patch
---

Fix `distributedTracing` precedence in Node `configure()`. An explicit `distributedTracing: false` was overridden by `LOGFIRE_DISTRIBUTED_TRACING=true`, while an explicit `true` correctly won over the environment. The code option now always wins, matching every other configure() setting, and an empty `LOGFIRE_DISTRIBUTED_TRACING` value is treated as unset instead of disabling distributed tracing.
