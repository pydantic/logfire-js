---
'@pydantic/logfire-node': patch
---

Shut down and flush the batch span processor even when the console processor fails. `LogfireSpanProcessor` awaited its console half first, so a console rejection skipped the batch processor's call — the one that exports whatever spans are still queued. Both calls now start together; a lone failure is rethrown unchanged and two are raised as an `AggregateError`, matching how the SDK's other lifecycle seams report.
