---
'logfire': patch
---

Fix nested field access in message templates. `{a.b}` previously resolved every path segment against the top-level attribute record, so it either fell back to the raw template or silently rendered an unrelated top-level attribute that shared the trailing segment name. Nested paths now walk into the attribute value, matching Python Logfire, and literal dotted attribute keys like `http.method` keep their existing precedence. Field lookups now use `Object.hasOwn`, so prototype members like `{user.toString}` no longer resolve. Index-style bracket syntax such as `{a[0]}` was never supported; when no literal attribute key matches, it previously rendered the string `undefined` and now warns and falls back to the raw template. An attribute whose literal key contains brackets (e.g. `'a[0]': value`) keeps resolving, as it did before.
