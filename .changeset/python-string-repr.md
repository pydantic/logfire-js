---
'logfire': patch
---

Match CPython's `repr()` when rendering string evaluation values in the `gen_ai.evaluation.result` log body. Values containing an apostrophe but no double quote now switch to double quotes instead of escaping the apostrophe, and control characters such as newlines and tabs are escaped rather than emitted literally, which previously broke the single-line body across multiple lines.
