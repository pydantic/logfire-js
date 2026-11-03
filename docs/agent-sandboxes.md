---
title: Agent Sandboxes
description: Run untrusted agent code in Logfire Agent Sandboxes from Node.js with @pydantic/logfire-agent-sandboxes.
---

# Agent Sandboxes

Logfire Agent Sandboxes run Python code that your agents write in isolated, remote
[Pydantic Monty](https://pydantic.dev/docs/monty/) sandboxes hosted by Logfire, and send the result back to your
application. The code never runs in your process, and it can reach the outside world only through the host functions
you pass to it.

`@pydantic/logfire-agent-sandboxes` connects to them from Node.js. It returns a `MontyWebsocket` pool from
`@pydantic/monty` that is already set up with your API key, your Logfire region, and the current trace context.

## Before you start

You need a Logfire API key with the **Run code in this project's agent sandboxes** permission
(`project:execute_agent_sandboxes`). In your project, go to **Settings → API Keys → New API Key**, select that
permission, and create the key. Agent Sandboxes accept only project API keys that aren't personal.

Set it as the `LOGFIRE_API_KEY` environment variable where your application runs:

```bash
export LOGFIRE_API_KEY='your-api-key'
```

The key also selects the data region your sandboxes run in, so you don't need to configure a URL.

## Install

```bash
npm install @pydantic/logfire-agent-sandboxes @pydantic/monty@^1.4.0
```

`@pydantic/monty` is a peer dependency. Version 1.4.0, the first with the WebSocket client, is published under the `next` tag, so name the version until it becomes `latest`. Import sessions, errors, and helpers such as `CollectString` from it directly.

## Run your first snippet

```ts
import { agentSandboxes } from '@pydantic/logfire-agent-sandboxes'

await using pool = await agentSandboxes()
await using session = await pool.checkout()
console.log(await session.feedRun('sum([20, 21, 1])')) // 42
```

No connection is made until `pool.checkout()`, which gives you a session with its own sandbox. Variables and functions
defined in one `feedRun()` call are available in later calls on the same session.

## Let sandbox code call your functions

Pass your own functions in `externalLookup`. Sandbox code calls them by name, and each call runs in your application.
This is the only way sandbox code can reach anything outside the sandbox, so expose only the functions the code needs.

```ts
import { agentSandboxes } from '@pydantic/logfire-agent-sandboxes'
import { CollectString } from '@pydantic/monty'

const output = new CollectString()
await using pool = await agentSandboxes()
await using session = await pool.checkout()
const result = await session.feedRun("print('Checking the weather')\nget_weather('London')", {
  externalLookup: { get_weather: (city: string) => `Sunny in ${city}` },
  printCallback: output,
})
console.log(result) // Sunny in London
console.log(output.output) // Checking the weather
```

Host functions can also be `async`.

## Persist, snapshot, and fork sessions

Sessions are saved by the server under `session.sessionId` when the connection closes, unless you check them out with
`pool.checkout({ ephemeral: true })`. To continue from saved state, call `session.loadSession(id)` on a new session.
`session.dump()` returns a snapshot ID you can load the same way, and loading one ID in several sessions forks it into
independent branches. Saved sessions and snapshots are kept for 7 days.

## Use with the Vercel AI SDK

An agent can write one Python program that calls its tools, instead of calling them one model turn at a time. With
AI SDK 7, define a `run_code` tool with `experimental_toolCaller` and route your other tools to it through
`experimental_toolCallers`. The model then sees only `run_code`, and the routed tools become Python functions in the
sandbox. Pass them to `feedRun()` in `externalLookup`:

```ts
import { agentSandboxes } from '@pydantic/logfire-agent-sandboxes'
import { experimental_toolCaller, tool } from 'ai'
import { z } from 'zod'

const inputSchema = z.object({ code: z.string() })

export const runCode = experimental_toolCaller(tool({ description: 'Run Python in a sandbox.', inputSchema }), {
  type: 'local',
  bind: (tools) =>
    tool({
      description: 'Run Python in a sandbox. Await these async functions with keyword arguments: ...',
      inputSchema,
      execute: async ({ code }, options) => {
        const externalLookup = Object.fromEntries(
          Object.entries(tools).map(([name, t]) => [name, (kwargs: unknown) => t.execute?.(kwargs, options)])
        )
        await using pool = await agentSandboxes()
        await using session = await pool.checkout({ ephemeral: true })
        return await session.feedRun(code, { externalLookup })
      },
    }),
})
```

Await `feedRun()` before you return, so that `await using` does not close the session while the code runs. Python
dicts come back as `Map`s, so convert the result to plain objects before the AI SDK sends it to the model.

[`examples/agent-sandboxes-ai-sdk`](https://github.com/pydantic/logfire-js/tree/main/examples/agent-sandboxes-ai-sdk)
is a complete agent. It generates type-checked Python signatures from the tools' schemas and records a span for each
tool call the code makes.

## Tracing

Each checkout sends the trace context that is active when you call `pool.checkout()`, so the spans Logfire records for
the session join your application's trace. This works with any OpenTelemetry setup that registers a W3C trace context
propagator, including [`@pydantic/logfire-node`](packages/node.md).

The code you run, its inputs, host function arguments and results, and printed output are sent to Logfire's servers to
be executed. Session state is stored for up to 7 days unless the session is ephemeral.

## Options

`agentSandboxes()` accepts every `MontyWebsocket` pool option, plus:

| Option   | Default                                                     | Description                                               |
| -------- | ----------------------------------------------------------- | --------------------------------------------------------- |
| `apiKey` | `LOGFIRE_API_KEY`                                           | API key with the `project:execute_agent_sandboxes` scope. |
| `url`    | `wss://<region host>/monty-ws/`, or from `LOGFIRE_BASE_URL` | WebSocket URL of the sandboxes server.                    |

The most common pool options:

- `maxProcesses`: the maximum number of sessions open at once (defaults to the number of CPUs). Further checkouts wait.
- `checkoutTimeout`: seconds `checkout()` waits for a free slot before rejecting. Defaults to waiting forever.
- `requestTimeout`: the maximum number of seconds for one call, such as `feedRun()` (default 10). Pass `null` to wait
  indefinitely.
- `connectHeaders`: extra headers for each connection. They are merged over the Logfire `Authorization` header and win
  on conflicts.

## Troubleshooting

- **`Agent sandboxes require a Logfire API key with the project:execute_agent_sandboxes scope`**: no API key was found.
  Set `LOGFIRE_API_KEY` or pass `apiKey`.
- **`failed to spawn monty worker: ... HTTP error: 401 Unauthorized`**: the server rejected the API key. Check that the
  key is correct, hasn't been deleted, and has the **Run code in this project's agent sandboxes** permission.
- **`MontyCrashedError` with `timedOut: true`**: the call took longer than `requestTimeout`. Pass a larger value.
