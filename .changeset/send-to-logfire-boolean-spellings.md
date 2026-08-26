---
'logfire': patch
---

Read `LOGFIRE_SEND_TO_LOGFIRE=0` and `f` as disabled instead of falling through to string truthiness, matching the boolean spellings the Python SDK accepts.
