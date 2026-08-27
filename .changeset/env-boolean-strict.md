---
'logfire': patch
---

Reject a boolean environment variable whose value is neither a true nor a false spelling, instead of reading it as false. `LOGFIRE_DISTRIBUTED_TRACING=yes` silently turned distributed tracing off, and `LOGFIRE_CONSOLE=on` silently turned the console off, because anything unrecognised fell through to the false branch. Both now fail with the value in the message, matching `_check_bool` in the Python SDK, and `0`/`f`/`false` are recognised explicitly.
