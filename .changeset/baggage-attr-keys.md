---
'logfire': patch
---

Stop dropping a baggage entry whose key names an inherited object member. `applyBaggage` tested for a conflict with `in`, so a `baggage` header carrying `toString` or `constructor` had that entry silently left off the emitted `gen_ai.evaluation.result` event.
