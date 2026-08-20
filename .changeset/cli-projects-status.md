---
"logfire": minor
---

Add `logfire projects status` to show what telemetry has actually reached the linked project, one row per service. It reads a read token saved by the new `logfire read-tokens create --save`, which stores the token in `.logfire/read_token.json` instead of printing it, so verifying your own setup never puts a token in a terminal, a CI log, or an agent's transcript.
