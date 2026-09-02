---
'logfire': patch
---

Keep a variable or label whose name is an `Object.prototype` member when normalizing the variables config. Both records were built by plain assignment, so a `__proto__` entry ran the inherited setter and vanished: a variable the store had accepted was missing from every config read back out of it, and a dropped label made the rollout validator report it as "not present in labels" for a label the payload does contain. Such a name satisfies the SDK's own identifier rule, the same one Python uses.
