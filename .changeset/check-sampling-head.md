---
'@pydantic/logfire-node': minor
---

`configure()` now throws when `sampling.head` is outside `0` to `1` or is `NaN`, instead of keeping every trace for a value above `1` or `NaN` and dropping every trace for a negative one
