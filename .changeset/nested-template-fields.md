---
'logfire': patch
---

Fix nested field access in message templates. `{a.b}` previously resolved every path segment against the top-level attribute record, so it either fell back to the raw template or silently rendered an unrelated top-level attribute that shared the trailing segment name. Nested paths now walk into the attribute value, matching Python Logfire, and literal dotted attribute keys like `http.method` keep their existing precedence.
