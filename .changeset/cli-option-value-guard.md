---
'logfire': patch
---

Reject an option value that is really the next flag in every CLI command. `read-tokens` already refused it, but the global options, `whoami`, `projects` and `clean` each had their own copy of the check without that guard, so `logfire clean --data-dir --logs` took `--logs` as the directory name and silently dropped the flag. The four copies are gone; there is one shared helper.
