---
'logfire': patch
---

Send a non-finite number nested inside an attribute as a string, the way a top-level one already is. `JSON.stringify` writes `NaN` and `Infinity` as `null`, so a nested one arrived indistinguishable from an actual null, and the generated JSON schema described it as `null` to match. Python's encoder returns `str(o)` for a non-finite float at any depth.
