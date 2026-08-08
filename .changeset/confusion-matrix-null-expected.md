---
'logfire': patch
---

Treat a null `expected_output` as missing in `ConfusionMatrixEvaluator` instead of as a class named `"null"`. A case with no expected output added a phantom row and column to the matrix, while a case with a null `output` was dropped, so the same absent value was counted on one axis and ignored on the other.
