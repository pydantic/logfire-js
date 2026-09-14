---
title: Mastra
description: Use @pydantic/logfire-agent-control-mastra to change a Mastra agent's instructions, model, settings, and tool definitions from Logfire.
---

# Mastra

[Agent Control](../agent-control.md) lets someone change what a running agent does — its instructions, its model, its model settings, the names and descriptions its tools are advertised under — from the Logfire UI, without a deploy. `@pydantic/logfire-agent-control-mastra` is the [Mastra](https://mastra.ai) half of it: one processor on an agent, and its configuration becomes a document you can edit in Logfire.

Until someone edits it, and any time Logfire cannot be reached, the agent runs exactly as your code defines it.

## Install

```bash
npm install @pydantic/logfire-agent-control-mastra @pydantic/logfire-node
```

`@mastra/core` 1.65 or newer is a peer dependency, and so is `@pydantic/logfire-node`, which is what the adapter resolves the variable through. There is nothing of its own to configure: the Logfire SDK's own configuration decides where the variable is read from.

## Usage

Add the processor to the agent's `inputProcessors`, last, so it applies the published config to the prompt every other processor has finished with:

```ts
import { Agent } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import { agentControl } from '@pydantic/logfire-agent-control-mastra'
import * as logfire from '@pydantic/logfire-node'
import { z } from 'zod'

logfire.configure()

const getWeather = createTool({
  id: 'get_weather',
  description: 'Get the weather for a city.',
  inputSchema: z.object({ city: z.string().describe('City name') }),
  execute: ({ city }) => Promise.resolve({ city, temperatureC: 21 }),
})

export const checkout = new Agent({
  id: 'checkout_assistant',
  name: 'Checkout Assistant',
  instructions: ['You are a concise checkout assistant.', 'Always confirm the order total.'],
  model: 'anthropic/claude-fable-5-1',
  tools: { getWeather },
  inputProcessors: [agentControl({ label: 'production' })],
})
```

The agent's config lives in a Logfire variable named `agent__checkout_assistant` — the agent's Mastra `id`, normalized by the contract's rule — or a `name` you pass to `agentControl` instead. The first request publishes a description of the agent as the variable's `example`, so the Logfire editor shows what it is you are changing.

`agentControl` also takes `label` (read one label rather than letting the variable's rollout choose), `onUnmatched` (`'warn'`, `'ignore'` or `'error'` for a published entry that reaches nothing), and `publishBaseline: false` (for a read-only token).

## What becomes editable

- **Instructions.** An agent whose `instructions` are a list gets one addressable block per entry, under `agent:0`, `agent:1`, and so on — or under an id the entry declares for itself as `providerOptions: { logfire: { id: 'persona' } }`, which is worth doing for anything you intend to manage, because a positional id re-points when you reorder the list. A published entry with no `id` adds a block, and it lands after your text and before anything Mastra assembles per request, so a provider's prompt cache keeps its prefix. Instructions written as a function are computed per request and are described but not editable, as are Mastra's own prompt sections — recalled memory, MCP guidance, a per-call `system` option.
- **Model.** A published `provider:model` becomes Mastra's `provider/model`. The provider has to be one Mastra's built-in model router knows; anything else is reported and the agent keeps its code-defined model rather than failing every request.
- **Model settings.** The contract's eleven canonical keys map onto Mastra's model settings, with `timeout` becoming its per-step budget and `parallel_tool_calls` becoming the provider option each provider spells differently. Whether a provider then acts on a setting is the provider's decision; one that will not reports an `unsupported` warning on the run.
- **Tool definitions.** A tool's description and its parameters' descriptions are patched onto what the model is told. A rename changes the name the model is offered and nothing else: the tool record Mastra dispatches, traces and stores from keeps its code-side keys, so your `execute` runs, your spans read, and your threads are written under the name your code gave the tool.

The package README carries the full table, including what happens for each row when it does not apply.

## Related Guides

- [Agent Control](../agent-control.md)
- [Managed Variables](../managed-variables.md)
- [Node.js](../packages/node.md)
