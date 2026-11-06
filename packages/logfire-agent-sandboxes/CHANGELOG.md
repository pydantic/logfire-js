# @pydantic/logfire-agent-sandboxes

## 0.2.0

### Minor Changes

- 6cdfeac: Connect to Logfire Agent Sandboxes over gRPC, which needs `@pydantic/monty` 1.5.0 or later (the peer dependency is now `^1.5.0`).
  
  `agentSandboxes()` now resolves to a `MontyRemote` pool, the new name of `MontyWebsocket`, and accepts every `MontyRemote` option. The default URL is the root of the region the API key belongs to, such as `https://logfire-us.pydantic.dev`, in place of `wss://<region host>/monty-ws/`. A custom `url` must be an `https://` or `http://` URL with no path. Extra request metadata goes in `metadata`; `connectHeaders`, its former name, still works but is deprecated. Metadata names are lowercased, so an entry such as `Authorization` replaces the Logfire one.

## 0.1.1

### Patch Changes

- Updated dependencies [6ab7b5a]
  - logfire@0.25.1

## 0.1.0

### Minor Changes

- ff9de45: Run untrusted agent code in Logfire Agent Sandboxes from Node.js, matching Python's `logfire.agent_sandboxes()`.
  
  `agentSandboxes()` resolves to a `MontyWebsocket` pool from `@pydantic/monty` (a peer dependency, `^1.4.0`). It authenticates with an API key that has the `project:execute_agent_sandboxes` scope, taken from `apiKey` or `LOGFIRE_API_KEY`. It dials the region the key belongs to (or `LOGFIRE_BASE_URL`, or `url`), and sends the trace context active at each checkout so the session's server spans join the caller's trace. All other `MontyWebsocket` options pass through.
