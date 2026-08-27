---
'logfire': patch
---

Round-trip the `EqualsExpected` evaluation name and let `Dataset.jsonSchema()` receive `primaryArgKeys`. `{EqualsExpected: 'x'}` decoded through the positional path and silently dropped the name (Python's dataclass accepts it positionally), and the instance schema API could not express the primary-arg option that `fromObject` already honours.
