---
'logfire': patch
---

Require `js-yaml` 4.3.2 or newer so YAML datasets loaded through `logfire/evals` get the fix that bounds CPU use for crafted merge keys (GHSA-2883-xcg3-v3hh).
