---
'logfire': patch
---

Keep a BigInt attribute instead of discarding it. `JSON.stringify` throws on a BigInt, so an attribute holding one anywhere — a nested `id` field took the whole surrounding object with it — collapsed to `[unserializable]`. A BigInt now follows the same rule as oversized number integers: sent as a number while the carrying double is exact, as its exact decimal string beyond that.
