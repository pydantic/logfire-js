---
'logfire': patch
---

Report a failing online-evaluation sink through the `onError` configured on each evaluator. Evaluators that share a sink are batched into one submit call, and the batch resolved a single handler from the first evaluator, so a handler set on any other evaluator in the batch never fired. The same resolution applies on the default-sink path, where a per-evaluator handler was skipped in favour of the config-level one.
