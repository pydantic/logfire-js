---
'@pydantic/logfire-node': patch
---

Shut the batch span processor down even when the console processor fails.

`LogfireSpanProcessor.forceFlush` and `.shutdown` awaited the console processor before the wrapped
one, so a console failure skipped the batch processor entirely and every span still queued for
export was dropped. Both calls now settle together, a lone failure is rethrown unchanged, and two
are raised as an `AggregateError`.
