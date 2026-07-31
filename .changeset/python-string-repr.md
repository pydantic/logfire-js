---
'logfire': patch
---

Match CPython's `repr()` when rendering string evaluation values in the `gen_ai.evaluation.result` log body. Values containing an apostrophe now switch to double quotes instead of escaping it, and control characters such as newlines and tabs are escaped rather than emitted literally, which previously broke the single-line body across multiple lines.
