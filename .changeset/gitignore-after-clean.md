---
'logfire': patch
---

Restore the data directory's `.gitignore` when credentials are written after `logfire clean`. The rule was only seeded when the directory was created, so re-authenticating into a directory that `clean` had emptied wrote `logfire_credentials.json` with no ignore rule covering it. A directory holding anything besides the files Logfire writes itself is still left alone.
