---
'logfire': patch
---

Stop `truncateString` splitting a surrogate pair. Truncation cut on UTF-16 code units, so a message value or baggage value long enough to be truncated with an astral character straddling the boundary kept only the high half, leaving a lone surrogate that is not valid UTF-8 once the attribute is serialized. The whole character is dropped instead.
