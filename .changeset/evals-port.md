---
'logfire': minor
'@pydantic/logfire-node': minor
---

Add evals support — offline + online evaluations.

A new `logfire/evals` (and `@pydantic/logfire-node/evals`) subpath exports `Dataset`, `Case`, `Evaluator`, built-in evaluators (`Equals`, `EqualsExpected`, `Contains`, `IsInstance`, `MaxDuration`, `HasMatchingSpan`, `LLMJudge`), report-level evaluators (`ConfusionMatrixEvaluator`, `PrecisionRecallEvaluator`, `ROCAUCEvaluator`, `KolmogorovSmirnovEvaluator`), and `withOnlineEvaluation` for runtime monitoring.

Emitted OTel spans and log events are wire-compatible with the Python `pydantic-evals` package, so experiments, cases, and live evaluations show up automatically in the Logfire web UI without any additional configuration. Datasets serialize to / deserialize from the same YAML and JSON format Python uses (`Dataset.toFile` / `Dataset.fromFile`, `Dataset.jsonSchema()`).

`logfire.configure()` now auto-installs the evals span-tree processor; users on a custom `TracerProvider` can install it manually with `getEvalsSpanProcessor()` from `logfire/evals`.
