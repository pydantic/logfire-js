# Logfire AI SDK Code Mode

Let [Vercel AI SDK](https://ai-sdk.dev) agents write one Python program that calls their tools, instead of calling them
one model turn at a time. The program runs in a [Logfire Agent Sandbox](https://pydantic.dev/logfire), and your tools
stay in your Node.js process.

```bash
npm install @pydantic/logfire-ai-sdk-code-mode @pydantic/monty@^1.5.0 ai zod
```

Create a Logfire project API key with the **Run code in this project's agent sandboxes** permission
(`project:execute_agent_sandboxes`) and set it as `LOGFIRE_API_KEY`. The key also selects your data region.

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
    stopWhen: stepCountIs(10),
  })
  return text
}
```

`codeMode()` turns your tools into typed async Python functions and gives the model one `run_code` tool to call them
from. Create one `codeMode()` object per agent run: it is one sandbox session, kept like a REPL for every `run_code`
call in that run.

See the [Agent Sandboxes docs](https://github.com/pydantic/logfire-js/blob/main/docs/agent-sandboxes.md#use-with-the-vercel-ai-sdk)
for streaming, approval, tool context, limits, and error handling.

You can pass your own pool as `sandboxes`. Code mode closes a pool it creates.
You must close a pool you pass in.

## Error routing and recovery

Python errors reach the model with guidance it can act on. Sandbox configuration
and infrastructure errors end the agent run with the original error instead.
Capacity refusals get one retry after 100 ms. A server shutdown gets one replay
on a fresh session if no host tool has been requested. Earlier snippets are not replayed.

With `streamText`, consume the stream and handle stream errors, then use
`code.closeWhenDone(result)` to close the session. Do not replace the
`run_code.toModelOutput` hook: it keeps infrastructure failures out of model
messages.

See [error routing and recovery](https://github.com/pydantic/logfire-js/blob/main/packages/logfire-ai-sdk-code-mode/docs/error-routing.md)
for the full error policy and streaming cleanup examples.
