---
'@pydantic/logfire-agent-sandboxes': minor
---

Run untrusted agent code in Logfire Agent Sandboxes from Node.js, matching Python's `logfire.agent_sandboxes()`.

`agentSandboxes()` resolves to a `MontyWebsocket` pool from `@pydantic/monty` (a peer dependency, `^1.4.0`). It authenticates with an API key that has the `project:execute_agent_sandboxes` scope, taken from `apiKey` or `LOGFIRE_API_KEY`. It dials the region the key belongs to (or `LOGFIRE_BASE_URL`, or `url`), and sends the trace context active at each checkout so the session's server spans join the caller's trace. All other `MontyWebsocket` options pass through.
