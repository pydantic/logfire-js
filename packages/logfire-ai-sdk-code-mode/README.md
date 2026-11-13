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

See the [Agent Sandboxes docs](https://pydantic.dev/docs/logfire/agent-sandboxes/typescript/#use-with-the-vercel-ai-sdk)
for streaming, approval, tool context, limits, and error handling.

Agent Sandboxes setup and checkout errors end the run instead of reaching the model.
Use `codeMode`'s `onError` handler for developer-side reporting, and handle thrown errors or rejected streams.
