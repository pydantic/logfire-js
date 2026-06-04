---
"@pydantic/logfire-node": minor
"logfire": minor
---

Add a Node-only `npx logfire` CLI for authentication, project selection/creation, read-token creation, local credential cleanup, `whoami`, and runtime info. The CLI writes Python-compatible global auth tokens and local `.logfire/logfire_credentials.json` project credentials.

`@pydantic/logfire-node` now reads local project credentials when no explicit token and no `LOGFIRE_TOKEN` are configured, while browser and worker packages remain credential-file free.
