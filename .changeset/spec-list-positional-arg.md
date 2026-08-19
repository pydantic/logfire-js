---
'logfire': patch
---

Encode an evaluator whose only argument is a list in the long form. `new Equals({ value: [1, 2] })` previously serialized to the short form `{Equals: [1, 2]}`, which reads back as two positional arguments and rebuilt the evaluator with the wrong ones. It now serializes to `{Equals: {value: [1, 2]}}`. Existing files that already contain the short form are unaffected by this change and still decode as positional arguments.
