---
'logfire': patch
---

Stop `renderReport` leaving a lone surrogate in a truncated cell. Inputs and outputs were cut on UTF-16 code units at 30, so an astral character straddling that boundary kept only its high half, and the returned report string is no longer valid UTF-8.
