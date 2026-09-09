# `@pydantic/logfire-agent-control-mastra`

Agent Control lets someone change what a running [Mastra](https://mastra.ai) agent does — its
instructions, its model, its model settings, the names and descriptions its tools are advertised
under — from the Logfire UI, without a deploy. Add one processor to an agent and its configuration
becomes a document you can edit in Logfire; until someone edits it, and any time Logfire cannot be
reached, the agent runs exactly as your code defines it.

You need Mastra (`@mastra/core` 1.65 or newer), the Logfire Node SDK, and a Logfire project. Nothing
here reads an environment variable of its own: the Logfire SDK's own configuration decides where the
variable is read from — `logfire.configure({ apiKey })` or `LOGFIRE_TOKEN`, with `LOGFIRE_BASE_URL`
naming the region.

```bash
npm install @pydantic/logfire-agent-control-mastra @pydantic/logfire-node
```

## Quick start

Add the processor to your agent's `inputProcessors`, last:

```ts
import { Agent } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import * as logfire from '@pydantic/logfire-node'
import { agentControl } from '@pydantic/logfire-agent-control-mastra'
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

const { text } = await checkout.generate('What is the weather in Paris?')
```

That is the whole installation. The agent's config lives in a Logfire variable named
`agent__checkout_assistant` — the agent's Mastra `id`, normalized by the core's rule (trimmed,
lowercased, everything outside `[a-z0-9_]` replaced with `_`), or a `name` you pass to `agentControl`
instead. The first request publishes a description of the agent, so the Logfire editor shows what it
is you are changing.

## The factory

```ts
agentControl(options?: MastraAgentControlOptions): InputProcessor
```

It returns a Mastra `InputProcessor` and nothing else: your agent, your tools and your model object
are not touched or mutated by this call. Register it **last** in `inputProcessors`, so it applies the
published config to the prompt every other processor has finished with.

- `name` — the variable name to use, instead of the agent's `id`. Pass it to keep the config attached
  across a rename of the agent, or to point two deployments at one config. An agent with neither an
  `id` nor a `name` fails the request with an error naming both ways to fix it.
- `label` — read this label instead of letting the variable's rollout choose one.
- `onUnmatched` — what to do about a published entry that reaches nothing: `'warn'` (default, once
  per process), `'ignore'`, or `'error'`, which fails the run. Mastra reports a processor that throws
  as a `PROCESSOR_WORKFLOW_FAILED` error carrying the message.
- `publishBaseline` — set `false` when the Logfire token is read-only, or when code must not write
  variable metadata.

One processor instance can be registered on several agents: each reads its own agent's variable, and
two requests that overlap never see each other's config.

For a step it applies a config to, the processor hands Mastra back new `systemMessages`,
`modelSettings`, `providerOptions`, `tools` and `model` **only** for the sections the published value
carries, and only where they differ from what the step already had. Everything else about the step is
the one Mastra assembled.

## What becomes editable

| Source, or canonical field                                                               | Block id, or runtime mapping                                                                             | Support                      | Conditions, and what happens when it does not apply                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `instructions` written as a list                                                         | `agent:0`, `agent:1`, … by position                                                                      | Yes                          | Ids are positional; see the next row for a stable one                                                                                                                                                                                                                                                                                                                          |
| `instructions` written as one string, or one message                                     | `agent`                                                                                                  | Yes                          |                                                                                                                                                                                                                                                                                                                                                                                |
| An instruction entry that declares its own id                                            | the declared id                                                                                          | Yes                          | Write the entry as a system message carrying `providerOptions: { logfire: { id: 'persona' } }` — the AI SDK v4 spelling, `experimental_providerMetadata`, is read too. Mastra's `instructions` takes a list of strings or a list of messages rather than a mix, so the other entries become messages with it. Worth doing: a positional id re-points when you reorder the list |
| `instructions` written as a function                                                     | `agent` for the first block, nothing after it                                                            | No                           | The text is built per request from the request context, so replacing it would freeze one rendering. An override naming it is reported as the dynamic block it is. To manage the fixed part, keep it in a list entry and add the computed part from a processor of your own — see below                                                                                         |
| Adding an instruction block                                                              | an entry with no `id`                                                                                    | Yes                          | Lands after your agent's own text and before anything Mastra adds per request, so a provider's prompt cache keeps its prefix                                                                                                                                                                                                                                                   |
| Mastra's own prompt sections — recalled memory, MCP guidance, a per-call `system` option | `tag:memory`, `tag:mcp-guidance`, `tag:user-provided`                                                    | No                           | They belong to the subsystems that write them. They are described in the baseline so the editor can show the prompt has more in it than your text; an override naming one is reported                                                                                                                                                                                          |
| `model`                                                                                  | `provider:model` → Mastra's `provider/model`                                                             | Conditional                  | The provider has to be one Mastra's built-in model router knows. Anything else — an unknown provider, one Mastra has no entry for (`bedrock`, `azure`, `cohere`, `google-cloud`), or one reachable only through a custom gateway — is reported, and the agent keeps its code-defined model                                                                                     |
| `max_tokens`                                                                             | `maxOutputTokens`                                                                                        | Yes                          |                                                                                                                                                                                                                                                                                                                                                                                |
| `temperature`                                                                            | `temperature`                                                                                            | Yes                          | Sent; a provider may still refuse it. OpenAI rejects it for its reasoning models, which every current GPT-5 is                                                                                                                                                                                                                                                                 |
| `top_p`                                                                                  | `topP`                                                                                                   | Yes                          | Sent; same caveat as `temperature` on OpenAI, and Anthropic's provider drops it when `temperature` is published with it                                                                                                                                                                                                                                                        |
| `top_k`                                                                                  | `topK`                                                                                                   | Yes                          | Sent; OpenAI has no field for it                                                                                                                                                                                                                                                                                                                                               |
| `seed`                                                                                   | `seed`                                                                                                   | Yes                          | Sent; neither OpenAI's Responses API nor Anthropic has a field for it                                                                                                                                                                                                                                                                                                          |
| `presence_penalty`                                                                       | `presencePenalty`                                                                                        | Yes                          | Sent; same                                                                                                                                                                                                                                                                                                                                                                     |
| `frequency_penalty`                                                                      | `frequencyPenalty`                                                                                       | Yes                          | Sent; same                                                                                                                                                                                                                                                                                                                                                                     |
| `stop_sequences`                                                                         | `stopSequences`                                                                                          | Yes                          | Sent; Anthropic takes it, OpenAI's Responses API has no field for it                                                                                                                                                                                                                                                                                                           |
| `timeout` (seconds)                                                                      | `timeout.stepMs`                                                                                         | Yes                          | Mastra's per-model-call budget, not a request field. A run-wide `totalMs` set in code is merged through rather than replaced. A value the contract cannot represent is dropped and reported by the core before it reaches Mastra                                                                                                                                               |
| `thinking`                                                                               | `reasoning` (`true` → `'provider-default'`, `false` → `'none'`)                                          | No, through the model router | Mastra passes `reasoning` only to AI SDK v7 (`LanguageModelV4`) providers, and `ModelRouterLanguageModel` — what every `provider/model` string resolves to — declares `specificationVersion = 'v2'`. So a published `thinking` on a router model is **always** reported rather than applied. Pass a v7 model object as the agent's `model` and it applies                      |
| `parallel_tool_calls`                                                                    | `providerOptions.openai.parallelToolCalls`; `providerOptions.anthropic.disableParallelToolUse`, inverted | Conditional                  | Those are the two providers that expose it, and both accept it. On any other provider it is reported, not applied                                                                                                                                                                                                                                                              |
| A tool's advertised name                                                                 | the model's declarations only; see "How a renamed tool behaves"                                          | Yes                          | A rename onto a name another tool already advertises is refused and reported, and that tool keeps its own name                                                                                                                                                                                                                                                                 |
| A tool's description, and its parameters' descriptions                                   | patched onto the tool Mastra advertises                                                                  | Yes                          | A patch naming a parameter the tool does not have, or one whose schema has nothing to describe, is reported                                                                                                                                                                                                                                                                    |
| A tool's parameters, types, or implementation                                            | —                                                                                                        | No                           | An override changes only what the model is told. Arguments are still validated against the schema your code declared                                                                                                                                                                                                                                                           |
| A provider-defined tool — `google.tools.googleSearch()` and its kind                     | —                                                                                                        | No                           | Its name is a contract with the provider, and Mastra advertises it under the tool's own `name` rather than the record key. It is neither described nor renamed, its advertised name is held against a managed rename of another tool, and an override naming it is reported                                                                                                    |
| Narrowing an override to one `toolset`                                                   | —                                                                                                        | No                           | By the time a processor sees them, Mastra has assembled every source (your tools, memory, workspace, skills, sub-agents, workflows, MCP) into one flat record with no source label, so overrides match by name alone                                                                                                                                                           |

"Sent" above means the value reaches the AI SDK call settings, which is as far as this adapter can
take it: whether a provider acts on one is the provider's decision, and a provider that will not
reports an `unsupported` warning on the run rather than failing it. The rows say what was **observed**
against `openai/gpt-5.4-nano` and `anthropic/claude-haiku-4-5`, not what was read off source.

Model ids are the contract's, which is Pydantic AI's vocabulary: `google` is the Gemini API and
`google-cloud` is Vertex AI. The v1 spellings `google-gla` and `google-vertex` are still accepted, so
a config published against an older agent keeps working, but they are never what a baseline publishes.

To keep a computed tail on your instructions while still managing the fixed part, leave the fixed
text in the agent's `instructions` and add the computed part from a processor registered **before**
this one:

```ts
import type { ProcessInputArgs, ProcessInputResult, Processor } from '@mastra/core/processors'

const today: Processor = {
  id: 'today',
  processInput({ messageList }: ProcessInputArgs): ProcessInputResult {
    return messageList.addSystem(`Today is ${new Date().toDateString()}.`, 'user-provided')
  },
}

// inputProcessors: [today, agentControl({ label: 'production' })]
```

## When it applies, and what beats what

**Resolution is once per request.** The variable is read in the processor's `processInput` hook,
which Mastra runs once, and the value is applied before **every** model call of that request. One
resolve per request is deliberate: it means the prompt prefix cannot change between the steps of one
run, which is what keeps a provider's prompt cache warm, and a value published mid-run takes effect
on the next request. Everything this adapter does for a request — applying the config, publishing the
baseline, reporting what did not apply — runs inside that resolution's telemetry context, and so does
the provider call itself wherever this adapter wraps the model (see below), so a span carries the
label and version that produced it.

**The baseline is published once per process, from the first request, as an observation.** The
agent's own text, model and default settings are read off the agent, but the tools the model is
offered are only assembled per request — a request carrying a memory, workspace or MCP toolset
assembles a different list — so the snapshot is published as the observation it is rather than as a
description of the code, and the variable says so. Publishing is a read-modify-write of the
variable's definition, so an edit saved in the Logfire UI inside that one round trip can be lost; set
`publishBaseline: false` and create the variable in the UI where that matters.

**Precedence is code < published < the values a run passed explicitly**, with one gap this
integration cannot close:

- **Instructions.** A per-run `instructions:` option replaces your agent's blocks outright, so the
  published ids no longer name the blocks they were written against: the section stands down, the
  caller's text is used, and the run reports that it did — a published section that reaches nothing
  should not do so silently. The same happens where two of your instruction blocks are identical,
  since Mastra drops the duplicate and every later position shifts; that report names the blocks to
  make distinct.
- **Model settings and provider options.** Mastra deep-merges a call's `modelSettings` and
  `providerOptions` into the agent's `defaultOptions` before any processor runs, and gives a
  processor nothing that records which keys the call carried. So "the caller set this" is recovered
  by comparing the step's value against the agent's default: a key that differs is the run's, and is
  left alone — in provider options as much as in model settings, so a run that sets
  `openai.parallelToolCalls` for itself keeps it. **The gap:** a call passing a value _equal_ to the
  agent's default is indistinguishable from a call that passed nothing, and the published value wins
  there. Where the three disagree, the run gets what it asked for; where the call and the code agree,
  the published value applies.
- **Model.** Mastra has no per-run model option, so a published model always applies. If your agent
  has a fallback list, a published model replaces the model for the step rather than reordering the
  list.

## How a renamed tool behaves

**Your code keeps seeing the name your code gave the tool.** Rename `getWeather` to
`lookup_current_weather` in Logfire and the model is offered `lookup_current_weather` — but the tool
record Mastra dispatches from keeps its `getWeather` key, so your `execute` runs, your tool hooks
fire, your spans are recorded and the thread's messages are stored all under `getWeather`. The rename
lives on the wire and nowhere else: for a request that renames something, this adapter hands Mastra a
wrapped model that advertises the managed names, translates the model's calls back before Mastra
dispatches them, and translates the replayed history forward on the way out.

Three consequences worth knowing:

- **A `toolChoice` naming a tool by its code name keeps working**, because it is translated with the
  declarations, and so does an `activeTools` list, which Mastra filters against the record's keys.
- **A thread survives the rename changing, or being withdrawn.** What was stored is code-side, so a
  resumed conversation is replayed under whatever the tool is advertised as now — or under its own
  name once the override is gone.
- **A thread stored by a build of this adapter older than this one is not repaired.** Those messages
  hold the managed name; nothing here rewrites them, and no versioned mapping is kept.

## Known limits

- The processor has to be registered on an `Agent` (`inputProcessors`). Mastra hands the agent to
  `processInput` only, so a processor-only workflow context has nothing to read the agent's
  configuration from; the adapter says so once and changes nothing.
- Instruction ids are positional unless an entry declares one. Reordering the entries in your code
  re-points every id after the one you moved, so a published override then addresses a different
  block, and a block whose source is deleted takes its id with it. Declare
  `providerOptions: { logfire: { id: … } }` on the entries you intend to manage.
- `thinking` cannot be applied to a model named as a `provider/model` router string; see the table.
- A per-run setting equal to the agent's own default cannot be told from an inherited one, and loses
  to a published value; see the precedence section.
- The baseline describes one request, and publishing it can lose a concurrent edit made in the UI.
- Overrides cannot be narrowed to a toolset, and provider-defined tools are not editable.

## Development

Run this package's checks from the repository root:

```bash
vp run @pydantic/logfire-agent-control-mastra#test
vp run @pydantic/logfire-agent-control-mastra#typecheck
vp lint packages/logfire-agent-control-mastra
```

Most of the suite is offline: a local variables provider and the AI SDK's mock models, so a test
asserts on the exact call Mastra would have made. The `live.test.ts` tests drive real providers and
replay from recorded cassettes in `src/__test__/cassettes/`; see `src/__test__/cassette.ts` for what
a cassette holds and how to re-record one.
