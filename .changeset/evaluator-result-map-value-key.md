---
'logfire': patch
---

Keep every entry of an evaluator result map that happens to contain a `value` key. A map such as `{ value: 0.8, confidence: 0.9 }` was read as a single `EvaluationReason`, so it produced one result named after the evaluator and the sibling keys were dropped without warning. A result map and an `EvaluationReason` are now told apart by their keys, since `EvaluationReason` declares only `value` and optional `reason`.
