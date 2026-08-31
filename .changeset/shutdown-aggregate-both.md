---
'@pydantic/logfire-node': patch
---

Report both shutdown failures instead of the first. `shutdown()` awaited the SDK and the variables teardown with `Promise.all`, which rejects on the first failure, so the second error was dropped and the operation it belonged to was left running past the call. They are now awaited together and every failure is collected, which is what the surrounding `AggregateError` handling was already built for.
