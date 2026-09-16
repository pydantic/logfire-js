---
'logfire': patch
---

Skip a case whose label key is absent instead of scoring it as a negative.

The threshold-sweeping report evaluators (PrecisionRecall, ROCAUC, KS) looked up the user's score
and positive keys with a bare index read, which finds the inherited member for a key naming an
`Object.prototype` member. The `labels` branch is the one that does not also type-check the value,
so an absent label resolved to the inherited function and `Boolean(undefined)` recorded the case as
ground-truth negative rather than skipping it, computing the metric over fabricated ground truth.
All four lookups now read own properties.
