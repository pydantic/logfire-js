# `@pydantic/logfire-agent-control-ai-sdk`

Agent Control lets someone change what a running [AI SDK](https://ai-sdk.dev) agent does — its
instructions, its model, its model settings, the names and descriptions its tools are advertised
under — from the Logfire UI, without a deploy. Pass your agent's settings through `agentControl` and
its configuration becomes a document you can edit in Logfire; until someone edits it, and any time
Logfire cannot be reached, the agent runs exactly as your code defines it.

Nothing here reads an environment variable of its own: the Logfire SDK's own configuration decides
where the variable is read from: `logfire.configure()`, with the read credential coming from
`LOGFIRE_API_KEY` (or `variables` passed to `configure`) and `LOGFIRE_BASE_URL` naming the region.

`@pydantic/logfire-node` is a peer dependency, so this adapter shares the copy your application
already configured rather than resolving a second one: the Logfire SDK keeps its variable provider in
a module-level singleton, and a nested copy would read a provider your `logfire.configure()` never
touched. The AI SDK (`ai` v7), `@ai-sdk/provider`, and `@ai-sdk/provider-utils` are peers for the same
reason a framework plugin's framework is. `@ai-sdk/gateway` is an optional one, needed only if someone
publishes a model string and you have passed neither `providers` nor `resolveModel`.

## Install

```bash
npm install @pydantic/logfire-agent-control-ai-sdk
```

## Quickstart

```ts
import * as logfire from '@pydantic/logfire-node'
import { anthropic } from '@ai-sdk/anthropic'
import { ToolLoopAgent, tool } from 'ai'
import { z } from 'zod'

import { agentControl } from '@pydantic/logfire-agent-control-ai-sdk'

logfire.configure({ serviceName: 'checkout' })

const get_weather = tool({
  description: 'Get the current weather for a city.',
  inputSchema: z.object({ city: z.string().describe('City name, e.g. `London`.') }),
  execute: async ({ city }: { city: string }) => `sunny in ${city}`,
})

const agent = new ToolLoopAgent(
  agentControl({
    settings: {
      id: 'checkout_assistant',
      model: anthropic('claude-fable-5-1'),
      instructions: [
        { role: 'system', content: 'You are a concise checkout assistant.' },
        {
          role: 'system',
          content: 'Always confirm the order total.',
          providerOptions: { logfire: { id: 'refunds' } },
        },
      ],
      tools: { get_weather },
    },
    label: 'production',
  })
)

const { text } = await agent.generate({ prompt: 'What is the weather in London?' })
console.log(text)
```

That is the whole installation. This agent's config lives in a Logfire variable named
`agent__checkout_assistant`, and the first model request publishes a description of the agent as
written, so the Logfire editor shows what it is you are changing.

For `generateText`, `streamText`, or anywhere else a `LanguageModel` goes, pass a model instead:

```ts
import { generateText } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'

import { agentControl } from '@pydantic/logfire-agent-control-ai-sdk'

const model = agentControl({
  model: anthropic('claude-fable-5-1'),
  name: 'checkout_assistant',
  // What your code declares, which is what a bare model cannot be asked; see "Precedence" and
  // "The baseline" for what changes when you leave these out.
  codeInstructions: 'You are a concise checkout assistant.',
  codeSettings: { temperature: 0.2 },
})

const { text } = await generateText({
  model,
  instructions: 'You are a concise checkout assistant.',
  prompt: 'Hello',
  temperature: 0.2,
})
```

## `agentControl`

One function, one options bag, two forms — told apart by whether you pass a `model`.

| Option                             | Applies to                                    | What it does                                                                                                                                                                                                                       |
| ---------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings`                         | the agent form                                | The settings you would have passed to `new ToolLoopAgent(...)`. Required for this form.                                                                                                                                            |
| `model`                            | the model form                                | The model to wrap. Required for this form, and it has to be a model object: a string is resolved by the AI SDK at call time, after this has run, so there would be nothing to wrap.                                                |
| `name`                             | both                                          | The agent's name, which picks out the `agent__<name>` variable. In the agent form it defaults to the settings' `id`, then to `telemetry.functionId`; with none of the three, the call throws rather than publishing under a guess. |
| `label`                            | both                                          | Read this label instead of letting the variable's rollout choose one.                                                                                                                                                              |
| `onUnmatched`                      | both                                          | What to do about a published entry that reaches nothing: `'warn'` (default, one `console.warn` per distinct message per process), `'ignore'`, or `'error'`, which throws `UnmatchedConfigError` out of the model request.          |
| `publishBaseline`                  | both                                          | Set `false` when the Logfire token is read-only, or when code must not write variable metadata.                                                                                                                                    |
| `providers`, `resolveModel`        | both                                          | How a published `provider:model` string becomes a model; see "Which provider a managed model goes to".                                                                                                                             |
| `codeInstructions`, `codeSettings` | the model form                                | What your code declares. The agent form reads both off `settings` and these are not accepted there.                                                                                                                                |
| `modelSpecificationVersion`        | the model form (and `agentControlMiddleware`) | Only for a hand-rolled `wrapLanguageModel` install; the two `agentControl` forms fill it in. See "Known limits".                                                                                                                   |

**What it returns.** The agent form returns a **new** settings object — your own is not mutated —
with three changes: `model` is wrapped in the Agent Control middleware, and `id` and
`telemetry.functionId` are filled in from the name **if they are not already set**. So an agent that
carries `id: 'checkout'` while you pass `name: 'checkout_assistant'` reads the config at
`agent__checkout_assistant` and still emits its traces under `checkout`: pass the same string to both,
or set `telemetry.functionId` yourself, if you want the trace and the config to answer to one name.
The model form returns a `LanguageModelV4`, which is the model your code passed with the middleware
wrapped around it; the original object is untouched.

`agentControlMiddleware({ name })` is the same thing as a plain `LanguageModelMiddleware`, for a
`wrapLanguageModel` or `createProviderRegistry` call you already have. It is the low-level API and it
knows least: everything the two `agentControl` forms fill in for you, it has to be told.

## What becomes editable

| Source / canonical field                                                                    | Block id or runtime mapping                                                                                                      | Support         | Conditions and unmatched behavior                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A block of `instructions` your code declares                                                | `system:0`, `system:1`, … in the order they reach the model, or `providerOptions: { logfire: { id: 'refunds' } }` on the message | **Yes**         | Replaced by publishing text, removed by publishing none. The block keeps its position in the prompt, and its own `providerOptions` — an Anthropic cache breakpoint included. An `id` this request assembles no block for is reported.                                                                                                                                                                                                            |
| Adding a block                                                                              | none — an entry with no `id`                                                                                                     | **Yes**         | Lands at the end of the static group, ahead of the first block the agent recomputes, so it never moves a provider's prompt-cache boundary. Text past the contract's per-request budget is refused, not truncated, and reported.                                                                                                                                                                                                                  |
| A block a `prepareCall` / `prepareStep` hook computes, or one carried in a run's `messages` | `system:<n>`                                                                                                                     | **No**          | Replacing it would pin one run's rendering forever and dropping it would remove the computation. Recognized by its text differing from what your code declares, and reported. With no declared instructions there is nothing to differ from, so such a block is addressable until a second request shows it changing; see "Known limits".                                                                                                        |
| A tool's advertised name                                                                    | `new_name`                                                                                                                       | **Yes**         | Your code keeps seeing the code-side name; see "What a renamed tool looks like from your code". A rename onto a name another tool already answers to — a provider-defined tool included — is dropped, the override's other patches still apply, and it is reported.                                                                                                                                                                              |
| A tool's description                                                                        | `description`                                                                                                                    | **Yes**         |                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| A tool's parameter descriptions                                                             | `parameters.<name>.description`                                                                                                  | **Yes**         | Top-level parameters only. A name the tool's schema has no property for is reported. Parameter names, types, requiredness, and validation stay code-defined.                                                                                                                                                                                                                                                                                     |
| Narrowing a tool override to one toolset                                                    | `toolset`                                                                                                                        | **No**          | The AI SDK's `tools` is one flat record with no grouping — `client.tools()` merges MCP tools into it too — so there is no toolset to match on and an override that sets one is reported.                                                                                                                                                                                                                                                         |
| A provider-defined tool (web search, code execution)                                        | —                                                                                                                                | **No**          | Its name and arguments are a contract with the provider, not text the model reads. It passes through untouched, and its name is reserved so nothing can be renamed onto it.                                                                                                                                                                                                                                                                      |
| Which tools exist at all                                                                    | —                                                                                                                                | **No**          | The config has no way to say it. `activeTools` is applied by the AI SDK before this middleware runs, so what reaches it is already the filtered set.                                                                                                                                                                                                                                                                                             |
| `model`                                                                                     | `provider:model`, e.g. `anthropic:claude-fable-5-1`                                                                              | **Conditional** | Resolved through `resolveModel`, else `providers`, else the AI Gateway; see "Which provider a managed model goes to". Anything that resolves to nothing is reported and the agent keeps its own model.                                                                                                                                                                                                                                           |
| `max_tokens`                                                                                | `maxOutputTokens`                                                                                                                | **Conditional** | Reaches every provider tested. Anthropic does not send it verbatim once `thinking` is on: the AI SDK raises the ceiling to fit the thinking budget, so a published 256 arrives as 6656. See "What a provider does with a published setting".                                                                                                                                                                                                     |
| `temperature`                                                                               | `temperature`                                                                                                                    | **Conditional** | Honoured by Gemini. Dropped by OpenAI's Responses API on a reasoning model and by Anthropic once `thinking` is on, in both cases by the provider rather than by this adapter.                                                                                                                                                                                                                                                                    |
| `top_p`                                                                                     | `topP`                                                                                                                           | **Conditional** | As `temperature`.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `top_k`                                                                                     | `topK`                                                                                                                           | **Conditional** | Honoured by Gemini. Dropped by OpenAI's Responses API always, and by Anthropic once `thinking` is on.                                                                                                                                                                                                                                                                                                                                            |
| `seed`                                                                                      | `seed`                                                                                                                           | **Conditional** | Honoured by Gemini. Not supported by OpenAI's Responses API or by Anthropic.                                                                                                                                                                                                                                                                                                                                                                     |
| `presence_penalty`                                                                          | `presencePenalty`                                                                                                                | **Conditional** | Not supported by OpenAI's Responses API or by Anthropic, which drop it. Gemini **rejects the request** with a 400 on the models that do not enable penalties, which is the one published setting observed to fail a run rather than be ignored.                                                                                                                                                                                                  |
| `frequency_penalty`                                                                         | `frequencyPenalty`                                                                                                               | **Conditional** | As `presence_penalty`.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `stop_sequences`                                                                            | `stopSequences`                                                                                                                  | **Conditional** | Honoured by Anthropic and Gemini. Not supported by OpenAI's Responses API.                                                                                                                                                                                                                                                                                                                                                                       |
| `thinking`                                                                                  | `reasoning` (`true` → `'provider-default'`, `false` → `'none'`, else the effort level)                                           | **Conditional** | `reasoning` is the one call option AI SDK v4 models added. `wrapLanguageModel` accepts a v2 or v3 model and bridges it with a proxy that answers `'v4'` and forwards, so an older provider is handed the field and drops it — on one of those it is reported instead of applied. On a v4 provider it is applied and accepted: OpenAI takes it as `reasoning.effort`, Anthropic as a `thinking` budget, Gemini as `thinkingConfig.thinkingLevel`. |
| `timeout` (seconds)                                                                         | an `AbortSignal` on each model request                                                                                           | **Yes**         | Composed with whatever signal the run carries, so either one still cancels; a value that is not a finite, non-negative number of seconds under 24.9 days is dropped and reported, and a positive one too small to round to a millisecond is armed at 1ms rather than throwing. A per-run timeout _longer_ than the published one cannot override it; see "Known limits".                                                                         |
| `parallel_tool_calls`                                                                       | `providerOptions.openai.parallelToolCalls`, `providerOptions.anthropic.disableParallelToolUse` (inverted)                        | **Conditional** | The AI SDK has no provider-neutral field for it. On any other provider it is reported, not applied.                                                                                                                                                                                                                                                                                                                                              |

Anything published that _this adapter_ cannot apply is reported through `onUnmatched`. What a
provider then does with a setting this adapter did apply is a separate question, and one `onUnmatched`
cannot answer; see below.

### What a provider does with a published setting

The eleven canonical settings are the contract's, not any one provider's, and a provider is free to
ignore a field the AI SDK sent it. The rows above say what each of OpenAI, Anthropic, and Gemini was
observed to do with a real request, rather than what their source suggested — three of those rows
changed when the observation was made.

Two things follow, and neither is fixable here:

- **The provider's own report is the AI SDK's, not Agent Control's.** A dropped setting comes back on
  `result.warnings` as `{ type: 'unsupported', feature: 'topK' }`, and the AI SDK also logs it. That
  is the list to read; `onUnmatched` never sees it, because from this adapter's side the setting was
  applied.
- **A published setting can fail a request outright.** Gemini answers `400 Penalty is not enabled for
this model` rather than ignoring `presence_penalty`, so publishing one takes that agent down until
  the value is removed. This is the exception to "a published value can only ever be ignored", and
  the reason to change one setting at a time on a production agent.

## When it applies

**Per model request** — every step of the tool loop, not once per conversation. A value saved in
Logfire reaches the next model request, with no restart. The whole request runs inside the
resolution's telemetry context, so its spans carry the label that drove it, and a rollout can move
between two steps of one run.

### The baseline

The **baseline** is what the Logfire editor shows you as the thing you are changing. It is published
in the background from the first model request, once per process per variable, so the variable
appears in Logfire once the agent has run once. Pass `publishBaseline: false` to turn it off.

A block's **text** is published only when this adapter can prove it is your code's: the agent form
reads it off `settings.instructions`, and the model form off `codeInstructions`. Every other block —
one a hook injected, or every block at all when nothing was declared — is published as a _seam_: its
id, and that it is there, with no text. The baseline goes into a variable every member of your
Logfire project can read, and a rendering this adapter merely observed is one tenant's, one user's,
one retrieved document's.

Model settings come from `codeSettings` where they were declared, and from the request otherwise. The
variable's description says which: "the agent as written" when both instructions and settings were
declared, and "snapshotted from one request" when they were not. The **tool list** is always the
request's, in both forms — the AI SDK resolves tool schemas on the way to a model, and a
`prepareStep` can change the set per step.

### Precedence

Code < published < what a run passed explicitly. By the time a request reaches a language model
middleware, the agent's settings and this call's are one object with no record of which came from
where, and there is no seam upstream that knows: `agent.generate()` takes no generation settings at
all, and `prepareCall` — the one per-run hook that does — is a whole-object transform whose idiom is
to spread through everything it did not change.

So a run's own values are recognized by comparison: a request field that differs from what your code
declares is one this run chose, and a published value does not overwrite it. That is exact except in
one case, and the case is worth knowing: a run that sets a key to the value your code already
declared is byte for byte a run that set nothing, and the published value wins. Without
`codeSettings` — a bare model or middleware install that was told nothing — there is no comparison to
make at all, and a published setting wins over a per-call one.

## What a renamed tool looks like from your code

Your code always sees the **code-side** name. A rename is a costume the tool wears in front of the
model: the request advertises `lookup_weather`, the model calls `lookup_weather`, and your
`get_weather` implementation runs with the arguments it sent. `result.steps[].toolResults`,
`onToolExecutionStart`, and `response.messages` all say `get_weather`.

Three things follow the rename outwards, so the model sees one consistent tool set:

- the tool definition in the request;
- a forced `toolChoice` that names the tool, which would otherwise name a tool this request no longer
  advertises;
- the `tool-call` and `tool-result` entries the SDK writes into the next step's prompt, which
  otherwise alternate names between steps and bust the prompt cache.

Parameter _names_ are never renamed, only their descriptions.

## Which provider a managed model goes to

`anthropic:claude-fable-5-1` has to become a model object. In order:

1. `resolveModel: (id) => …` if you pass one. It is **authoritative**: what it returns is the answer,
   and returning `undefined` means "not a model I will build", which keeps your model and reports the
   published value. It is never a first guess that falls through to the steps below.
2. `providers: { anthropic, openai }` if you pass them — the same record `createProviderRegistry`
   takes, and `:` is already its separator. **Use this** to reach providers configured with your own
   API key, base URL, or `fetch`. A key here is read exactly as written, before any name translation.
3. Otherwise the [AI Gateway](https://ai-sdk.dev/docs/ai-sdk-core/provider-management) (or whatever
   `globalThis.AI_SDK_DEFAULT_PROVIDER` names), with `:` rewritten to the `/` the gateway spells it
   with — the same place a bare string model would have gone.

The contract's provider vocabulary and the AI SDK's agree on every name but Vertex AI, and they even
agree on `google` for the Gemini API. Vertex is `google-cloud` to the contract and `vertex` to the AI
SDK — the name `@ai-sdk/google-vertex` exports its provider under — so a published `google-cloud:…`
is resolved through your `vertex` provider, and a `@ai-sdk/google-vertex` model is published as
`google-cloud:…`. That reverse direction reads more than the first segment of the provider id on
purpose: `@ai-sdk/google` reports `google.generative-ai` and `@ai-sdk/google-vertex` reports
`google.vertex.…`, so going by the namespace alone would name a Vertex model as a Gemini API one.

`google-gla` and `google-vertex` are Pydantic AI v1's names for the same two providers. They were
removed in v2, and they are still accepted here as input, because a config published against a v1-era
agent is still sitting in a Logfire project; nothing ever publishes them.

A name none of that covers is forwarded as it stands, so a provider package released tomorrow works
here on the day it lands. If it reaches a registry or a gateway that has never heard of it, the
failure is reported through `onUnmatched` and your code's model is kept.

## Known limits

- **A model swap is invisible to AI SDK telemetry.** The span still reports the code-defined
  `modelId`, because `wrapLanguageModel` fixes that at wrap time and a published value is only known
  once the variable resolves. The adapter warns once when it happens.
- **A model passed as a string** (`model: 'anthropic/claude-fable-5-1'`) cannot be managed: the AI SDK
  resolves it at call time, so there is nothing to wrap. `agentControl` refuses it with that message.
- **A per-run `timeout` cannot override a published one.** By the time a request reaches a model, the
  AI SDK has merged the run's `timeout` and its `abortSignal` into one signal with nothing to tell
  them apart. The published budget is therefore composed with it and the shorter of the two wins.
- **Positional block ids move.** If a hook injects a system message ahead of your own, `system:0` is
  now that message; the adapter notices the text no longer matches and refuses to apply an override
  rather than rewriting the wrong block. Declare `providerOptions.logfire.id` to be safe.
- **A dynamic block is protected only once the adapter knows your code.** With `codeInstructions` or
  an agent's own `instructions`, an injected block is refused from the very first request. Without
  them, the first request has nothing to compare against and treats every block as addressable; from
  the second request on, a block whose text changed is refused. Its text is never published into the
  baseline in either case.
- **A pre-v4 model has to say so** when you install `agentControlMiddleware` by hand:
  `wrapLanguageModel` hides the real version behind a proxy, so pass
  `modelSpecificationVersion: 'v3'` or a published `thinking` will be applied where it does nothing.
  Both `agentControl` forms read it off the model you give them.
- **A tool override invalidates the prompt cache.** Anthropic caches tools ahead of the system
  prompt, so any tool rename or description edit rewrites the whole cached prefix — once, when you
  publish.
- **A provider has the last word on a setting**, and can reject the request over one. See "What a
  provider does with a published setting".
- **A baseline publish can lose a concurrent UI edit.** The platform API has no example-only write,
  so publishing re-reads the variable and writes it back whole; a value saved in Logfire inside that
  one round trip is overwritten. It runs at most once per process, off the request path, and is
  skipped when the example is already current. Set `publishBaseline: false` if that window matters.

## Development

From the repository root:

```bash
vp install
vp run --filter "./packages/*" build                       # the core this package imports
vp run @pydantic/logfire-agent-control-ai-sdk#test
vp run @pydantic/logfire-agent-control-ai-sdk#typecheck
vp check                                                   # format and lint, repository-wide
```

Most of the suite runs offline against `MockLanguageModelV4` and the Logfire SDK's own
`LocalVariableProvider`, so it drives the real AI SDK and the real variable plumbing with no network
and no fixtures to drift.

`src/__test__/live.test.ts` is the exception: it settles the claims only a real provider can, and
replays from the cassettes in `src/__test__/cassettes/` — no credentials, no network. Re-record them
with:

```bash
node scripts/record-live-cassettes.mjs --env-file <a .env with OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY>
```
