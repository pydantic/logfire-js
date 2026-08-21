---
'logfire': patch
---

Report a variable reference graph that exceeds the composition depth limit during `variablesValidate`. Validation allowed one hop more than composition can expand, so a 21-link chain was reported as valid and then failed at resolve time with `Variable composition exceeded maximum depth of 20`.
