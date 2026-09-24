---
'logfire': patch
---

Keep scrubbing off a managed variable's own label. `logfire.variables.<name>` says which label served a run, and its key carries your variable's name, so a variable called `prompt__session_summary` or `agent__auth_router` matched the default patterns on its key and reported `[Scrubbed due to 'session']` in place of the label on every span inside the resolution. Keys under `logfire.variables.` are now safe, which is the version attribution those attributes exist to provide; nothing about the value was ever sensitive, since a label is a name you chose.
