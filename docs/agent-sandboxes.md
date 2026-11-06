---
title: Agent Sandboxes
description: Run untrusted agent code in Logfire Agent Sandboxes from Node.js with @pydantic/logfire-agent-sandboxes.
---

# Agent Sandboxes

Logfire Agent Sandboxes run Python code that your agents write in isolated, remote
[Pydantic Monty](https://pydantic.dev/docs/monty/) sandboxes hosted by Logfire, and send the result back to your
application. The code never runs in your process, and it can reach the outside world only through the host functions
you pass to it.

`@pydantic/logfire-agent-sandboxes` connects to them from Node.js. It returns a `MontyRemote` pool from
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
npm install @pydantic/logfire-agent-sandboxes @pydantic/monty@^1.5.0
```

`@pydantic/monty` is a peer dependency. Version 1.5.0 or later is required, because Logfire serves Agent Sandboxes over gRPC and that is the first version with the gRPC client. Import sessions, errors, and helpers such as `CollectString` from it directly.

## Run your first snippet

```ts
import { agentSandboxes } from '@pydantic/logfire-agent-sandboxes'

await using pool = await agentSandboxes()
await using session = await pool.checkout()
console.log(await session.feedRun('sum([20, 21, 1])')) // 42
```

No connection is made until `pool.checkout()`, which gives you a session with its own sandbox. Variables and functions
defined in one `feedRun()` call are available in later calls on the same session.

`await using` is JavaScript's
[explicit resource management](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/await_using),
supported in Node.js 24 and TypeScript 5.2 and later. It works like Python's `async with`: when the enclosing block
exits, normally or by an exception, JavaScript awaits the value's `Symbol.asyncDispose` method. For a session, that
returns its sandbox to the pool. For the pool, it closes the pool. Values are disposed in reverse order, so the session
closes before the pool. The `await` is for that cleanup, not for creating the value: `await agentSandboxes()` and
`await pool.checkout()` are separate awaits on the right-hand side. Without `await using`, close them in `finally`:

```ts
const pool = await agentSandboxes()
try {
  const session = await pool.checkout()
  try {
    console.log(await session.feedRun('sum([20, 21, 1])'))
  } finally {
    await session.close()
  }
} finally {
  await pool.close()
}
```

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

An agent can write one Python program that calls its tools, instead of calling them one model turn at a time.
`codeMode()` from `@pydantic/logfire-ai-sdk-code-mode` turns AI SDK tools into typed async Python functions in a sandbox
session and gives the model one `run_code` tool to call them from. The package is not on npm yet.

```ts
import type { LanguageModel } from 'ai'

import { codeMode } from '@pydantic/logfire-ai-sdk-code-mode'
import { generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'

const getWeather = tool({
  description: 'Get the weather for a city.',
  inputSchema: z.object({ city: z.string() }),
  outputSchema: z.object({ city: z.string(), forecast: z.string() }),
  execute: async ({ city }) => ({ city, forecast: 'Sunny' }),
})

export async function askAgent(model: LanguageModel, prompt: string): Promise<string> {
  await using code = codeMode({ tools: { get_weather: getWeather } })
  const { text } = await generateText({
    model,
    prompt,
    tools: code.tools,
    // The default is one step, which ends the run before the model sees the result of run_code.
    stopWhen: stepCountIs(10),
  })
  return text
}
```

The model sees the tools only as Python signatures in the `run_code` description, so do not also pass them to
`generateText`. Tools that should stay direct can be spread in next to `code.tools`. Give each tool an `outputSchema`,
so the model knows what a call returns. Sandbox code chooses the arguments, so define tool schemas with zod 4.6.6 or
later: earlier versions validate every element of an oversized array before checking its length
([GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)).

One `codeMode()` object is one sandbox session, kept like a REPL for every `run_code` call it serves, so create one per
agent run. The session joins the trace that is active when you call `codeMode()`.

`codeMode()` is synchronous and starts nothing: it checks out the session on the first `run_code` call, from
`agentSandboxes()` unless you pass `sandboxes`. `await using code = codeMode(...)` only means that when `askAgent`
returns or throws, JavaScript awaits `code[Symbol.asyncDispose]()`, which closes the session, and the pool too if
`codeMode()` created it. It is the same as calling `await code.close()` in a `finally` block:

```ts
const code = codeMode({ tools: { get_weather: getWeather } })
try {
  const { text } = await generateText({ model, prompt, tools: code.tools, stopWhen: stepCountIs(10) })
  return text
} finally {
  await code.close()
}
```

With `streamText`, the function returns before the stream is read, so a block-scoped close would end the session too
early. Call `code.closeWhenDone(result)` instead, which closes once the stream finishes, fails or is aborted. A session
also ends after `idleTimeout` milliseconds without a call (default 300,000, five minutes).

Calling a tool from the sandbox skips the AI SDK's own approval and context handling, so `codeMode()` takes them as
options:

- `context`: each tool's context, keyed by tool name, as `toolsContext`.
- `approval`: the same shape as `toolApproval`, without the `'user-approval'` status, because nothing in the sandbox
  can wait for a person. An async function can ask one itself and return `'approved'` or `'denied'`, within
  `limits.timeout`. Tools with `needsApproval` are rejected.
- Sandbox code gets what `execute` returns, so a tool with `toModelOutput` is rejected rather than having its
  filtering bypassed.
- `limits`: a wall-clock `timeout` per snippet that includes time spent waiting on tools (in milliseconds, default 30,000), and caps
  on nested calls, concurrent calls, and the sizes of code, results and tool input and output.
- `onToolError`: replaces a tool's error message before the sandbox, the model or a span sees it. Messages pass through
  unchanged by default. A result that has no JSON form, such as a bigint or a cycle, is not a tool error, so it does not
  go through `onToolError`.
- A tool result is sent to the sandbox as JSON. A `Map` becomes a dict and a `Set` becomes a list.

If you pass your own `sandboxes`, set its `requestTimeout`, which Monty takes in seconds, above `limits.timeout`, so that a long snippet gets the
time-limit message instead of a dropped connection. `codeMode()` does this for the pool it creates.

[`examples/agent-sandboxes-ai-sdk`](https://github.com/pydantic/logfire-js/tree/main/examples/agent-sandboxes-ai-sdk)
is a complete agent over a larger data set, with a smoke test.

## Tracing

Each checkout sends the trace context that is active when you call `pool.checkout()`, so the spans Logfire records for
the session join your application's trace. This works with any OpenTelemetry setup that registers a W3C trace context
propagator, including [`@pydantic/logfire-node`](packages/node.md).

The code you run, its inputs, host function arguments and results, and printed output are sent to Logfire's servers to
be executed. Session state is stored for up to 7 days unless the session is ephemeral.

## Options

`agentSandboxes()` accepts every `MontyRemote` pool option, plus:

| Option   | Default                                             | Description                                                                       |
| -------- | --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `apiKey` | `LOGFIRE_API_KEY`                                   | API key with the `project:execute_agent_sandboxes` scope.                         |
| `url`    | `https://<region host>`, or from `LOGFIRE_BASE_URL` | `https://` or `http://` URL of the sandboxes server, no path, query, or fragment. |

The most common pool options:

- `maxProcesses`: the maximum number of sessions open at once (defaults to the number of CPUs). Further checkouts wait.
- `checkoutTimeout`: seconds `checkout()` waits for a free slot before rejecting. Defaults to waiting forever.
- `requestTimeout`: the maximum number of seconds for one call, such as `feedRun()` (default 10). Logfire requires a
  finite value; do not pass `null`.
- `metadata`: a function that returns extra gRPC request metadata (headers) for each checkout. Its entries are merged
  over the Logfire `authorization` entry and win on conflicts. Names are matched case-insensitively. `connectHeaders`,
  its former name, still works but is deprecated.

## Troubleshooting

Pool creation checks the API key and URL configuration. The first connection is made at `pool.checkout()`.
The package exports three error classes:

| Error                         | When it is raised                                                                                                          | Details                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `AgentSandboxError`           | SDK configuration is invalid; also the base class for the errors below.                                                    | `message` explains what to change.                                                                                      |
| `AgentSandboxRefusedError`    | The server refuses a checkout, whether or not a Logfire hint applies.                                                      | `statusCode`, `statusMessage`, and `reason` preserve the server's details. `cause` is the original `MontyRefusedError`. |
| `AgentSandboxConnectionError` | Any other failure to create the pool or check out a session, including connection, metadata, or checkout timeout failures. | `cause` is the original failure.                                                                                        |

Messages from the SDK start with **Agent Sandboxes**. Refusal and connection errors keep the original error object
on the standard `Error.cause`, so consumers can walk the cause chain. On a refusal, `reason` is the policy string
that Monty 1.5.0 exposes as its own `cause`; the outer `cause` is an error, not that string. Missing server fields
are `null`; if the server sends no status message, the outer message says `no server status message`.

**This wrapping stops at checkout.** Errors from operations on a checked-out session, such as `feedRun()`, pass
through unchanged. These include user-code errors and `MontyCrashedError`, `MontyDisconnectError`, and `MontyShutdown`.
The Monty cause and session-error examples below show version 1.5.0; newer Monty versions can change that text.

### API keys and project access

If no API key is set, `agentSandboxes()` raises:

```text
AgentSandboxError: Agent Sandboxes require a Logfire API key with the `project:execute_agent_sandboxes` scope. Set the LOGFIRE_API_KEY environment variable or pass `apiKey` to `agentSandboxes()`.
```

Set `LOGFIRE_API_KEY` or pass `apiKey`. If a key is present but the server refuses access, the outer error is:

```text
AgentSandboxRefusedError: Agent Sandboxes refused the session: unauthenticated
Use a project API key (not a personal API key) with the `project:execute_agent_sandboxes` scope. Check that the key's region matches the URL and that Agent Sandboxes are enabled for the project.
```

Its `statusCode` is `UNAUTHENTICATED`. The original error stays on `error.cause`, for example:

```text
MontyRefusedError: RuntimeError: failed to spawn monty worker: https://logfire-us.pydantic.dev: UNAUTHENTICATED: unauthenticated
```

The outer message can mean that the key is incorrect, belongs to another region, is a personal key, or belongs to a
project that does not have Agent Sandboxes enabled. The message alone does not distinguish these cases. Check all
of the following:

- Use a **project API key**, not a personal key. Check that it is correct and has not been deleted.
- Give it the **Run code in this project's agent sandboxes** permission (`project:execute_agent_sandboxes`).
- Use the key's region. Remove an incorrect `url` or `LOGFIRE_BASE_URL` override to let the SDK select the region.
- Check that Agent Sandboxes are enabled for the project.

**Agent Sandboxes not enabled:** ask a project admin to enable Agent Sandboxes for the project. A valid key with the
correct scope can still receive `UNAUTHENTICATED: unauthenticated` until the project has access.

**`PERMISSION_DENIED`:** when `error.statusCode === 'PERMISSION_DENIED'`, inspect `error.statusMessage` for the server's
reason. The outer message is `Agent Sandboxes refused the session: <server status message>`, followed by the same
configuration hint as `UNAUTHENTICATED`. Check the project key, scope, region, and project access listed above.
The original refusal remains on `error.cause` even when no hint applies.

### URL and connection errors

Both `url` and `LOGFIRE_BASE_URL` must contain only the scheme, host, and optional port. Trailing slashes are allowed.
A path, query, or fragment raises this error before checkout:

```text
AgentSandboxError: Agent Sandboxes URL must use http://<host> or https://<host> with no path, query or fragment. Remove the old /monty-ws/ path from `url` or LOGFIRE_BASE_URL.
```

Use, for example, `https://logfire-us.pydantic.dev`, not `https://logfire-us.pydantic.dev/monty-ws/`. The `/monty-ws/`
path was used before version 0.2.0. The current client selects its fixed gRPC session path itself.

Connection failures raise `AgentSandboxConnectionError`, with the original failure on `error.cause`. For example,
the outer messages can be:

```text
AgentSandboxConnectionError: Agent Sandboxes could not connect to https://logfire-us.pydantic.dev: connect timed out after 10s
AgentSandboxConnectionError: Agent Sandboxes could not connect to https://logfire-us.pydantic.dev: not a gRPC server, the response's content-type is text/html
```

The corresponding causes in Monty 1.5.0 can be:

```text
Error: failed to spawn monty worker: https://logfire-us.pydantic.dev: connect timed out after 10s
Error: failed to spawn monty worker: https://logfire-us.pydantic.dev: not a gRPC server, the response's content-type is text/html
```

- **`connect timed out`:** check the hostname, port, DNS, and network access. Check that a firewall or proxy permits
  the HTTP/2 gRPC connection to the Logfire host. The timeout can also mean that the server did not accept the session
  in time. If the URL and network are correct, retry after a delay or use a larger finite `requestTimeout` for slow
  session setup. Retrying cannot fix an incorrect URL.
- **`not a gRPC server`:** the response is not gRPC. Check `url` and `LOGFIRE_BASE_URL`, and use the Logfire region
  host without an added path. A proxy or load balancer can also return an HTML error page during an outage, so check
  for a temporary service or proxy failure before changing a known-correct URL. Connection failures can be plain
  `Error` instances inside `AgentSandboxConnectionError.cause`, not `MontyRefusedError`.

### Capacity refusals

A burst of checkouts can fail with this outer error:

```text
AgentSandboxRefusedError: Agent Sandboxes refused the session: assignment attempt rate exceeded
Too many sessions are being opened at once. Lower `maxProcesses` or retry after a delay.
```

The original refusal remains on `error.cause`, for example:

```text
MontyRefusedError: RuntimeError: failed to spawn monty worker: https://logfire-us.pydantic.dev: RESOURCE_EXHAUSTED: assignment attempt rate exceeded
```

When `error.reason === 'caller_cap'`, too many sessions are being opened at once. Lower `maxProcesses` or retry after
a delay. When `error.reason === 'capacity'`, the service is at capacity; retry after a delay. `error.statusCode` and
`error.statusMessage` retain the server status, while `error.cause` retains the original refusal object. A refused
checkout did not create a session, so no sandbox code ran and retrying the checkout is safe.

### Lost sessions and shutdown

The errors below are not wrapped when they come from an operation on an already checked-out session. If a failure
instead occurs during pool creation or checkout, it is wrapped as `AgentSandboxConnectionError` (or
`AgentSandboxRefusedError` for a refusal), with the original failure on `cause`.

**`MontyDisconnectError: RuntimeError: monty worker connection closed while waiting for a reply`:** inspect `error.statusCode`,
`error.statusMessage`, `error.cause`, and `error.transportError`. The short message alone does not explain why the
session ended. `cause` can identify a policy limit, such as `idle_timeout`, `session_timeout`, `turn_timeout`, or
`capacity`; it is a string, not an `Error`. A transport failure can leave the status and cause fields `null`.
Check out a new session and restore saved state if available. Do not retry a feed blindly: the interrupted code or
host function might already have run.

**`MontyShutdown: RuntimeError: monty server is shutting down; the request did not run`:** the server is shutting down
and the session is lost. The pool tries to resume it automatically when `autoResume` is enabled (the default). If
shutdown still reaches your code, check out a new session. Use
`error.dump`, when present, with `loadSession()` for an idle session or `loadSnapshot()` for a suspended feed. The
request that raised `MontyShutdown` did not run, so retrying that request is safe. Restoring a suspended feed can
call a host function again; account for repeated host calls.

**`MontyCrashedError` with `timedOut: true`:** the call exceeded the client-side `requestTimeout`. Use a larger finite
value if the operation is expected to take longer. The session is lost, so check out a new one. Increasing this
timeout does not increase the project's sandbox limits below.

### Project time and memory limits

Hosted sandboxes have project limits, by default about **50 ms per feed** and **20 MiB of memory**. Errors can look
like these (the measured values vary):

```text
MontyRuntimeError: TimeoutError: feed time limit exceeded: 60ms > 50ms
MontyRuntimeError: MemoryError: memory limit exceeded: 21043973 bytes > 20971520 bytes
```

Reduce the work or memory used by the code, or ask a project admin to raise the sandbox limit in project settings.
A larger limit requested at checkout does not override the project cap; it can be lowered to that cap without a
warning. A `MemoryError` does not by itself end the session.

Each `time.sleep()` call is capped at about **10 seconds**. A longer sleep can return early without an error. If the
code needs a longer delay, split it into calls of at most 10 seconds and allow enough time in the finite
`requestTimeout` for the whole operation. This sleep cap is separate from the project feed time and memory limits.
