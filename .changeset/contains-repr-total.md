---
'logfire': patch
---

Stop a `Contains` mismatch reason from failing or flattening on a value `JSON.stringify` cannot represent.

`truncatedRepr` read `.length` off the result outside its own try, so an output property whose
value is `undefined` reported an evaluator failure instead of the mismatch it had found. A `BigInt`
anywhere in the output threw, and the `String(value)` fallback rendered the whole object as
`[object Object]`, losing every other field. Both now go through `attributeJsonReplacer`, the same
replacer the attribute seam applies.
