---
'logfire': patch
---

Stop `Contains` leaving a lone surrogate in a truncated failure reason. The reason string was cut on UTF-16 code units at both ends, so an astral character straddling either boundary lost half of itself, and the resulting reason is not valid UTF-8 once the evaluation result is serialized.
