---
'logfire': patch
---

Keep both ends when truncating a message field or a baggage value.

`truncateString` dropped everything past the limit and appended an ellipsis, so a long value lost
its tail, which is usually the part that tells two values apart: the id at the end of a path, the
filename at the end of a URL. Python's `truncate_string` puts the ellipsis in the middle and keeps
both halves, and it is the same function behind both of the call sites here, message field values
in `scrubbing.py` and baggage values in `baggage.py`. Both cuts are placed on a code point
boundary, so neither end can keep half a surrogate pair.
