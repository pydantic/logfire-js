---
'logfire': patch
---

Expand references in a referenced variable's value when they follow an even backslash run. The fast-path guard in `expandReferenceSerializedValue` tested the JSON-encoded text with a single-character lookbehind, so any `@{ref}@` preceded by a literal backslash was treated as escaped. A value such as `\\@{inner}@` therefore skipped composition entirely and `inner` was left unexpanded and absent from `composedFrom`, even though the same string expands when it appears at the top level.
