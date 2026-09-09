---
'logfire': patch
---

Keep both ends when truncating a message field or baggage value. `truncateString` kept only the head, but the tail is usually what tells two long values apart — an asset hash at the end of a URL, an ID at the end of a path — and Python's `truncate_string` already keeps both halves around a middle ellipsis for the same fields. Both cuts respect surrogate pairs.
