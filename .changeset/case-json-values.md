---
'logfire': patch
---

`LogfireAPIClient.addCases` and `updateCase` now reject `inputs`, `expectedOutput` and `metadata` values JSON cannot represent, such as Maps, Sets, non-finite numbers and bigints. They previously went through `JSON.stringify` and were silently changed or failed with a transport error, so the dataset could hold different data than was passed in. The error is now a `DatasetConfigurationError` naming the field and path, as `pushEvaluationDataset` already does.
