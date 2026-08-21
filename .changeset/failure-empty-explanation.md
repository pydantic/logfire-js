---
'logfire': patch
---

Omit `gen_ai.evaluation.explanation` on an evaluator failure that carries no message, instead of emitting an empty string. pydantic-evals leaves the attribute off in that case, so a failure from `throw new Error()` no longer records an explanation that is not one.
