---
title: Agent Control
description: Use @pydantic/logfire-node/agent-control to change an agent's instructions, model, settings, and tool definitions from Logfire.
---

# Agent Control

Agent Control lets someone change what a running agent does — its instructions, its model, its model settings, the names and descriptions its tools are advertised under — from the Logfire UI, without a deploy.

An agent's configuration lives in one [managed variable](managed-variables.md) named `agent__<name>`, holding a document called an `AgentConfig`. Every value in it is a _patch_ on the agent as written: a section that is present is managed from Logfire, a section that is absent keeps its code-defined behavior, and deleting a section in Logfire is a deliberate revert to code. If Logfire is unreachable, if nothing has been published, or if a published value cannot be understood, the agent runs on its code. A remote configuration must never take an agent down.

`@pydantic/logfire-node/agent-control` is that mechanism with no agent framework attached: the contract, the variable plumbing, and pure helpers that apply a published value to whatever a given framework calls its instructions, its tools, and its settings. A framework adapter is a thin layer on top.

## Install

```bash
npm install @pydantic/logfire-node
```

Agent Control resolves its variable through the same configuration as every other managed variable, so there is nothing of its own to configure:

```ts
import * as logfire from '@pydantic/logfire-node'

logfire.configure({
  apiKey: process.env.LOGFIRE_API_KEY,
  serviceName: 'checkout-api',
})
```

## Usage

```ts
import { AgentControl, applyInstructions, applySettings, applyToolDefinitions, buildBaseline } from '@pydantic/logfire-node/agent-control'

const control = new AgentControl('checkout_assistant', { label: 'production' })
const options = { onUnmatched: control.onUnmatched }

// Once per process, so the Logfire editor knows what it is editing.
control.publishBaseline(buildBaseline({ instructions: codeBlocks, model, settings, tools: codeTools }))

// Once per run: resolve, then do the whole run inside the resolution's telemetry context.
const answer = await control.run(async ({ config }) => {
  if (config === null) {
    return runTheAgent({ blocks: codeBlocks, tools: codeTools, settings, model })
  }
  const { blocks } = applyInstructions(codeBlocks, config, options)
  const { tools, routes } = applyToolDefinitions(codeTools, config, options)
  return runTheAgent({
    blocks,
    tools,
    routes,
    settings: { ...settings, ...applySettings(config, options) },
    model: config.model ?? model,
  })
})
```

Every span opened inside `run` carries the selected label on the SDK's own `logfire.variables.agent__checkout_assistant` baggage key, so a trace says which published version drove it. That is the difference between "this agent regressed" and "this agent regressed on the value someone saved at 14:02".

`resolution()` and `resolve()` are there for an adapter whose framework offers no single scope to wrap. Where a framework hands out two hooks per run — an instructions callable and a model wrapper — resolve once and install that one resolution for the rest with `useResolution`, so a publish between the two cannot send prompt A with model B.

## The Config Shape

This is what someone publishes in the Logfire UI. Every key is optional.

```jsonc
{
  "instructions": [
    "Escalate anything over $500 to a human.", // no id -> adds a block
    { "id": "agent", "instructions": "You are a refund specialist." }, // rewrites the agent's own text
    { "id": "agent:refunds", "instructions": "Confirm the order total." }, // rewrites one named block
    { "id": "toolset:legacy_crm" }, // no text -> removes that block
  ],
  "model": "anthropic:claude-fable-5-1",
  "settings": { "temperature": 0.4, "max_tokens": 2048, "thinking": "high" },
  "tool_definitions": [
    {
      "name": "get_weather",
      "new_name": "lookup_weather",
      "description": "Look up the current weather for a city.",
      "parameters": { "city": { "description": "City name, e.g. 'London'" } },
    },
  ],
}
```

A bare `"instructions": "text"` is also valid and means one added block, so a hand-written value gets the short form.

`settings` carries eleven canonical keys, and only those: `max_tokens`, `temperature`, `top_p`, `top_k`, `seed`, `presence_penalty`, `frequency_penalty`, `parallel_tool_calls`, `timeout`, `stop_sequences`, `thinking`. These are the settings every framework Agent Control drives has a knob for, under the names Pydantic AI's `ModelSettings` gives them, so one published value means the same thing to every SDK reading it. Anything else is ignored and reported.

## The Baseline

The **baseline** is the same shape, describing the agent rather than changing it. The Logfire editor renders it as the thing a managed value is layered onto: it is published as the variable's `example`, and it is never resolved and never applied.

```jsonc
{
  "instructions": [
    { "id": "agent", "instructions": "You are a concise checkout assistant.", "dynamic": false },
    { "id": "agent:refunds", "instructions": "Always confirm the order total.", "dynamic": false },
    { "id": "agent:today", "dynamic": true },
  ],
  "model": "anthropic:claude-fable-5-1",
  "settings": { "temperature": 0.1 },
  "tool_definitions": [
    {
      "name": "get_weather",
      "description": "Get the current weather for a city.",
      "parameters": { "city": { "description": "City to look up." } },
      "toolset": "<agent>",
    },
  ],
}
```

Two rules about what a baseline carries are worth stating outright, because both are about not leaking anything into a document every member of a Logfire project can read:

- **A dynamic block publishes its seam, never its text.** An instruction recomputed per request reads the run — a tenant, a user id, a retrieved document — so the baseline says only that the block exists and that it is not editable. That is also exactly what the editor needs.
- **Settings are filtered to the canonical keys.** A framework's settings also carry provider-specific ones and things like extra headers and bodies, which is where authorization headers live. Those still apply to the run; they are just not part of this contract.

`buildBaseline` produces the document and `control.publishBaseline` writes it. The write happens in the background, at most once per process per variable, and never throws. Pass `{ source: 'observed' }` when the earliest anything could be read was one request rather than the agent object, because the two mean different things to whoever reads them. If the variable does not exist it is created with the contract's stored JSON schema, which the Logfire backend then validates every written value against.

Set `publishBaseline: false` when the variables token is intentionally read-only, or when code must not write variable metadata. Updating an existing variable is read-modify-write — the platform API takes the whole definition and offers no conditional write — so a value saved in the Logfire UI during that one round trip can be overwritten. The provider is refreshed from the server first, the variable is re-read immediately before the write, and the write is skipped when the baseline is already current, which is the steady state for a deployed agent; a deployment that cannot tolerate that window should turn the publish off and create the variable in the UI.

## The Contract

Three things have to give the same answer in every language that implements Agent Control, because a Logfire project is shared and the SDKs are not.

**Agent name to variable key.** A config lives at `agent__<key>`, where the key is the name trimmed, lowercased, with every character outside `[a-z0-9_]` replaced by `_`, runs of `_` collapsed, and `_` stripped from both ends. A name with nothing left after that is refused rather than turned into a variable. Lowercasing is the lossy step and it is the point: it is the rule the Logfire UI applies, so a Pydantic AI agent called `Checkout Assistant` and a Mastra agent called `checkout-assistant` land on the one config the UI shows for them. `control.name` stays the display name you passed; `control.variableName` is the key.

**The unit of resolution.** Resolve once per run where the framework has a run seam, and hold that one `Resolution` for the whole of it: every span then agrees on the version that produced it, and a value published mid-run takes effect on the next run. Where a framework offers only a per-model-request hook, resolution is per request. Both are supportable. What is not supportable is resolving twice in one request.

**Parsing a published value.** Leniency is per section: a section, entry, or setting this release cannot make sense of costs only itself, and everything around it still applies — because a value that fails validation outright falls back to the code-defined agent in its entirety. An invalid `model` drops only `model`. The instruction budget is charged to surviving entries only. Text length is counted in Unicode code points, so an emoji costs the same here as it does in Python. And `''` is never a value: not "no model", not "no instructions", just a field someone left half-filled.

A published entry that is perfectly valid but reaches nothing in _this_ deployment — an instruction `id` no block carries, an override no advertised tool matches, a settings key that could not be applied — goes through the control's `onUnmatched` policy: `'warn'` (the default, once per process per message), `'error'`, or `'ignore'`. Each is a place where Logfire shows one thing and the agent does another, so none of them is dropped in silence.

The stored JSON schema is pinned by `SCHEMA_SHA256`, and the cross-language rules above are pinned by conformance vectors this package runs against in its own test suite.

## Framework Adapters

The core is framework-neutral on purpose: it knows about instruction blocks, tool definitions, and settings, and about no framework's spelling of them. An adapter is what maps one framework onto those three: it enumerates a baseline, installs the framework's hook, and calls the pure helpers.

[**Mastra**](frameworks/mastra.md) has one: `@pydantic/logfire-agent-control-mastra`, a processor you add to an agent's `inputProcessors`. Adapters for the **Vercel AI SDK** and the **OpenAI Codex SDK** are in progress, each as its own package, because a project that uses one has no reason to install the other two. Until they land, the paragraph below is how to drive Agent Control from any framework directly.

Python users get the same contract from [`logfire`](https://logfire.pydantic.dev/docs/) and [`pydantic-ai-harness`](https://github.com/pydantic/pydantic-ai-harness). A config published from the Logfire UI drives every one of them, because the variable name, the baseline, and the parse are the same three rules in both languages.

Writing an adapter for something else is five things and nothing else: construct an `AgentControl`, resolve once per run, call `applyInstructions` / `applyToolDefinitions` / `applySettings`, build a baseline with `buildBaseline`, and publish it. `control.reportUnmatched(message)` is how an adapter puts a section its framework cannot honor at all — a published `model` where models cannot be switched — through the same policy as everything else, rather than dropping it in silence; `reportUnapplied(keys)` does the same for the settings keys it has no knob for.

See `examples/node/agent-control.ts` for a complete runnable example against a local variables config.

## Related Guides

- [Managed Variables](managed-variables.md)
- [Node.js](packages/node.md)
- [Configuration](configuration.md)
