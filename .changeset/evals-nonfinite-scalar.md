---
'logfire': patch
---

Report an evaluator failure when a case evaluator returns `NaN` or `Infinity` instead of recording it as a score. A single non-finite score made the mean for that key `NaN` across the whole experiment, and pydantic-evals rejects these values outright.
