---
'logfire': patch
---

Keep online-evaluation sinks running when OTel emission fails for one evaluator. Emission ran unguarded before the sinks, so an evaluator whose spec could not be JSON-serialized threw out of the whole dispatch: the other evaluators' results never reached the sink, and the configured `onError` was never called because the dispatch promise is discarded.
