---
'logfire': patch
---

Encode an evaluator whose only argument is a list in the long form. `new Equals({ value: [1, 2] })` serialized to `{Equals: [1, 2]}`, which reads back as the multi-positional form and rebuilt the evaluator with the wrong arguments.
