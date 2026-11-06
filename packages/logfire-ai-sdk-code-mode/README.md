# AI SDK code mode

This private, unpublished package gives an AI SDK agent one `run_code` tool. The
model writes Python that can call your tools. A sandbox session keeps variables,
imports, and function definitions between snippets in the same run.

```ts
import { codeMode } from '@pydantic/logfire-ai-sdk-code-mode'
import { generateText, stepCountIs } from 'ai'

await using code = codeMode({ tools })
const result = await generateText({
  model,
  prompt,
  tools: code.tools,
  stopWhen: stepCountIs(10),
})
```

The example assumes that `tools`, `model`, and `prompt` are defined. Set
`LOGFIRE_API_KEY` to a project API key with the
`project:execute_agent_sandboxes` scope, or pass your own pool as `sandboxes`.
Code mode closes a pool it creates. You must close a pool you pass in.

Python errors reach the model with guidance it can act on. Sandbox configuration
and infrastructure errors end the agent run with the original error instead.
Capacity refusals get one retry after 100 ms. A server shutdown gets one replay
on a fresh session if no host tool has been requested. Earlier snippets are not replayed.

With `streamText`, consume the stream and handle stream errors, then use
`code.closeWhenDone(result)` to close the session. Do not replace the
`run_code.toModelOutput` hook: it keeps infrastructure failures out of model
messages.

See [error routing and recovery](docs/error-routing.md) for the full error policy
and streaming cleanup examples.
