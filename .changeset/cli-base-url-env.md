---
'logfire': patch
---

Read `LOGFIRE_BASE_URL` in the CLI. The SDK already resolves its endpoint from that variable and the docs present it as the way to reach a self-hosted Logfire, but the CLI only looked at `--base-url` and `--region`, so `logfire whoami` and the other commands still called the public API. Either flag continues to take precedence, and a blank value is ignored rather than rejected.
