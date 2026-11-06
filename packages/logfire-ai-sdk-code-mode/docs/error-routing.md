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
Use `onSandboxError` to report it to developer-controlled logging. This
synchronous hook runs once per failed code mode instance, including for pool
creation and checkout failures. Exceptions from this hook do not replace the
original error. It does not receive recoverable Python errors.
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
Only the reserved marker `{ sandboxFailure: true }`, not the error details, is
serialized into a UI stream. This differs from a successful empty result (`{}`).
UI clients must treat that marker as a failed call, not a completed execution.
When converting saved UI messages for a later turn, pass `code.tools` to
`convertToModelMessages`. The output hook converts the saved marker to generic
failure text, without exposing the original error or claiming that the call
succeeded. This does not resume the failed code mode instance.

With `generateText`, catch the rejected call. With `streamText`, handle errors
when you consume the stream and close code mode even if consumption fails:

```ts
const code = codeMode({
  tools,
  onSandboxError: (error) => console.error('Sandbox infrastructure failed', error),
})
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
and `prompt` are defined. For infrastructure failures, `fullStream` iteration
rejects with the original error. It does not emit an `error` part, and the AI SDK
`onError` callback is not called. The `error`-part check above handles other AI
SDK errors, not sandbox infrastructure failures. Catch iteration failures at
your application boundary.

UI responses created with `toUIMessageStreamResponse` abort mid-stream for these
failures, after sending the failure marker. Their `onError` callback is not
called either. Use `onSandboxError` for server-side reporting even when your
framework consumes the response body. `closeWhenDone` still settles and closes
code mode; it does not report the error. Do not rely on a second model call to
report infrastructure errors. Error messages can contain configuration details;
keep them in developer-controlled error handling.

An unrecognized `MontyDisconnectError` deliberately ends the run. Monty reports
both worker death and connection loss with this error, and the client cannot
tell which happened without a recognized cause. Retrying unknown disconnects
would also retry infrastructure failures. The request might have run before
the connection was lost, so a retry could repeat side effects. Distinguishing
worker death from connection loss requires more specific information from the
sandbox service; code mode does not guess from error text.

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
current Monty API does not expose a server retry delay. The backoff timer keeps
the Node.js process alive until the retry, even for a pool with no other active
handles. Aborting or closing code mode during the backoff prevents the retry.

A `MontyShutdown` means that the individual request that failed did not run.
Code mode closes the lost session and replays the current snippet once on a
fresh session, with type checking enabled according to `typeCheck`. The replay
uses the original snippet deadline. It does not extend the time limit.

Sessions are ephemeral. A replacement does not recover variables, imports, or
definitions from earlier snippets. Code mode does not replay earlier snippets,
which could repeat side effects. A successful replay returns its output under
`result`, with a `sessionReset` message that tells the model to recreate state.
If the replay has a Python error or returns a result over the size limit, its
message also explains the lost state. Printed output from the failed attempt
is discarded, so only the replay's output is returned.
A shutdown can also occur while answering a
host callback, after part of a snippet has run. If any host tool has been requested in
the current snippet, including a call waiting for validation, approval, or a free
execution slot, code mode ends the run instead of replaying it. Pending callbacks
are cancelled before the lost session is released. A second
shutdown or a failed replacement checkout also ends the run.
