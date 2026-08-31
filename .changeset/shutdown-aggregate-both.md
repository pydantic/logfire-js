---
'@pydantic/logfire-node': patch
---

Report both shutdown failures instead of the first. `shutdown()` awaited the SDK and the variables teardown with `Promise.all`, which rejects on the first failure, so the second error was dropped and the operation it belonged to was left running past the call. Each failure is now recorded as its own operation settles, so an early one survives even when the other teardown outlives the deadline.
