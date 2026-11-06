---
'@pydantic/logfire-agent-sandboxes': minor
---

Connect to Logfire Agent Sandboxes over gRPC, which needs `@pydantic/monty` 1.5.0 or later (the peer dependency is now `^1.5.0`).

`agentSandboxes()` now resolves to a `MontyRemote` pool, the new name of `MontyWebsocket`, and accepts every `MontyRemote` option. The default URL is the root of the region the API key belongs to, such as `https://logfire-us.pydantic.dev`, in place of `wss://<region host>/monty-ws/`. A custom `url` must be an `https://` or `http://` URL with no path. Extra request metadata goes in `metadata`; `connectHeaders`, its former name, still works but is deprecated. Metadata names are lowercased, so an entry such as `Authorization` replaces the Logfire one.
