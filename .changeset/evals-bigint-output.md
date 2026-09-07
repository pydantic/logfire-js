---
'logfire': patch
---

Stop a task's own return value from breaking the evals output seams.

`renderReport` passed `JSON.stringify` straight into `truncate`, which reads `.length`. A task that
returns nothing gives `undefined` rather than a string, so rendering the report with
`includeOutput` threw `Cannot read properties of undefined`, and a `BigInt` anywhere in the value
threw outright. `withOnlineEvaluation`'s `recordReturn` had the same `BigInt` gap and recorded
`[unserializable]` for the whole return value. Both now use the replacer the attribute seam
already applies.
