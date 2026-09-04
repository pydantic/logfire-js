---
'logfire': patch
---

Send a BigInt attribute as its exact decimal string instead of discarding it. `JSON.stringify` throws on a BigInt, so one anywhere in an attribute produced `[unserializable]`, and a nested one took the whole surrounding object with it.
