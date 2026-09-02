---
'logfire': patch
---

Look up evaluator names as own properties of a plain-object registry in `decodeEvaluator` and `decodeReportEvaluator`. A name read from a dataset file previously resolved through the prototype chain, so `constructor` returned `Object` and was constructed into something that is not an evaluator, while `toString` failed with `Cls is not a constructor` instead of the unknown-name error.
