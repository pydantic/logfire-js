---
'logfire': patch
---

Generate a dataset JSON Schema that matches the evaluator forms the loader accepts. The schema only described `{Name: {kwargs}}`, so the short form `{Equals: 1}` that `Dataset.toText`/`toObject` writes failed validation in an editor, while a bare `Equals` validated even though constructing it with no arguments throws.
