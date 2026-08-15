---
'logfire': patch
---

List each evaluator once in the dataset JSON schema. An evaluator that was both registered and passed through `customEvaluators` produced two identical `oneOf` branches, and `oneOf` requires exactly one match, so a dataset file naming that evaluator failed to validate against its own schema.
