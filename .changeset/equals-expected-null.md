---
'logfire': patch
---

Treat a null `expected_output` as missing in `EqualsExpected`. A dataset case written with `expected_output: null` produced a failing assertion instead of no assertion, which is what pydantic-evals records and what #219 already settled for the confusion matrix.
