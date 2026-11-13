# Logfire Agent Sandboxes

Run Python that your AI agents write in isolated, remote [Pydantic Monty](https://pydantic.dev/docs/monty/) sandboxes
hosted by [Pydantic Logfire](https://pydantic.dev/logfire), from Node.js.

```bash
npm install @pydantic/logfire-agent-sandboxes @pydantic/monty@^1.5.0
```

Create a Logfire project API key with the **Run code in this project's agent sandboxes** permission
(`project:execute_agent_sandboxes`) and set it as `LOGFIRE_API_KEY`. The key also selects your data region.

```ts
import { agentSandboxes } from '@pydantic/logfire-agent-sandboxes'

await using pool = await agentSandboxes()
await using session = await pool.checkout()
console.log(await session.feedRun('sum([20, 21, 1])')) // 42
```

`agentSandboxes()` resolves to a `MontyRemote` pool from `@pydantic/monty`, set up with your API key, region URL,
and the trace context active at each checkout. It accepts every `MontyRemote` option, plus `apiKey` and `url`.

The package exports `AgentSandboxError`, `AgentSandboxRefusedError`, and `AgentSandboxConnectionError`. Refusal and
connection errors preserve the original error on `cause`. Errors from operations on a checked-out session pass
through unchanged.

See the [Agent Sandboxes docs](https://pydantic.dev/docs/logfire/agent-sandboxes/typescript/) for host
functions, sessions, snapshots, and options.
