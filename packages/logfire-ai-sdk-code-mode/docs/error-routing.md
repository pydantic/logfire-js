# Error routing and recovery

Code mode separates errors the model can fix from errors the developer must fix.
This policy applies to both `generateText` and `streamText`.

## Developer errors

These failures end the agent run. They do not become model tool errors:

- Pool creation failures, such as an invalid configuration.
- Session checkout failures, including invalid credentials, denied access,
  invalid URLs, and connection failures.
- Capacity refusals that still fail after one retry.
- Disconnects without a recognized timeout cause, protocol failures, and other
  unclassified infrastructure failures during execution.
- A second server shutdown, or a shutdown after a host tool has been requested.

Code mode preserves the original error object, including its status and cause.
The `onToolError` option only replaces errors from your nested tools. It does not
replace sandbox infrastructure failures. After an infrastructure failure, queued
calls return the same failure without opening another session. Fix the problem
and create a new code mode instance for a new run.

Missing `LOGFIRE_API_KEY` credentials for the default pool already fail when you
call `codeMode()`, before a model request starts.

The AI SDK normally converts exceptions from a tool's `execute` function to
model tool errors. Code mode uses an internal failure result and throws its
original error from `run_code.toModelOutput`, outside that conversion. Pass
`code.tools` to the AI SDK without replacing that hook. An adapter that executes
tools itself must also invoke `toModelOutput` before it sends results to a model.
The failure result stores the original error in a JavaScript private field.
Only an opaque marker, not the error details, can be serialized into a UI stream.

With `generateText`, catch the rejected call. With `streamText`, handle errors
when you consume the stream and close code mode even if consumption fails:

```ts
const code = codeMode({ tools })
const result = streamText({ model, prompt, tools: code.tools })
try {
  for await (const part of result.fullStream) {
    if (part.type === 'error') {
      throw part.error
    }
    if (part.type === 'text-delta') {
      process.stdout.write(part.text)
    }
  }
} finally {
  await code.closeWhenDone(result)
}
```

The example assumes that the functions are imported and that `tools`, `model`,
and `prompt` are defined. A stream can also reject during iteration. Do not rely
on a second model call to report infrastructure errors. Error messages can
contain configuration details; keep them in developer-controlled error handling.

## Errors sent to the model

Syntax, type, and Python runtime errors reach the model. Ordinary code errors
keep the current session. Resource exhaustion resets it and explains how to
reduce work or memory use.

| Failure                                                                    | Guidance for the model                                                                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `MontyCrashedError` with `timedOut: true`                                  | The code exceeded its time limit. Recreate state and do less work per call.                             |
| `MontyDisconnectError` with `cause: 'turn_timeout'`                        | The same time-limit guidance.                                                                           |
| `MontyDisconnectError` with `cause: 'session_timeout'` or `'idle_timeout'` | The session ended and its state is lost. Recreate state and check started tool calls before continuing. |
| `MontyCrashedError` without `timedOut`                                     | The worker crashed. Revise the code and use a new session.                                              |

Known timeout and crash messages list host tool calls that already started.
Do not repeat completed side effects. A timeout disconnect does not prove that
the in-flight request did not run, so code mode does not replay it.

## Bounded recovery

A checkout refusal with cause `caller_cap`, `capacity`, or `worker_unavailable`
gets one retry after 100 ms. Authentication and permission failures never retry,
even if they have a capacity cause. Pool creation failures do not retry. The
current Monty API does not expose a server retry delay. Aborting or closing code
mode during the backoff prevents the retry.

A `MontyShutdown` means that the individual request that failed did not run.
Code mode closes the lost session and replays the current snippet once on a
fresh session, with type checking enabled according to `typeCheck`. The replay
uses the original snippet deadline. It does not extend the time limit.

Sessions are ephemeral. A replacement does not recover variables, imports, or
definitions from earlier snippets. Code mode does not replay earlier snippets,
which could repeat side effects. A successful replay returns its output under
`result`, with a `sessionReset` message that tells the model to recreate state.
If the replay has a Python error, its message also explains the lost state.
A shutdown can also occur while answering a
host callback, after part of a snippet has run. If any host tool has been requested in
the current snippet, including a call waiting for validation, approval, or a free
execution slot, code mode ends the run instead of replaying it. Pending callbacks
are cancelled before the lost session is released. A second
shutdown or a failed replacement checkout also ends the run.
