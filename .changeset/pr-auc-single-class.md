---
'logfire': patch
---

Report `PrecisionRecallEvaluator` as not computable when every case shares one class. With only positive cases it returned an AUC of 1, and with only negative cases an AUC of 0, so a dataset that carries no signal read as a perfect or a worthless model. `ROCAUCEvaluator` and `KolmogorovSmirnovEvaluator` already return `NaN` and no curve for the same input.
