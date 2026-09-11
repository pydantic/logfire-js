---
'logfire': patch
---

Keep the confusion matrix when a case output holds a `BigInt`.

`ConfusionMatrixEvaluator` built its axis labels with a bare `JSON.stringify`, which throws on a
`BigInt` at any depth. `runEvaluators` catches that, so a task returning a large integer id or
token count lost the entire analysis to a report-evaluator failure. A top-level `BigInt` now joins
the other primitives, and everything else goes through `attributeJsonReplacer`, the replacer the
attribute seam already applies.
