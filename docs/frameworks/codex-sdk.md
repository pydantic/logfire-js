---
title: OpenAI Codex SDK
description: Use @pydantic/logfire-agent-control-codex-sdk to change a Codex agent's instructions, model, and reasoning effort from Logfire.
---

# OpenAI Codex SDK

[Agent Control](../agent-control.md) lets someone change what a running agent does from the Logfire UI, without a deploy. `@pydantic/logfire-agent-control-codex-sdk` is the adapter for the [Codex SDK](https://developers.openai.com/codex/sdk): it makes a Codex agent's developer instructions, its base prompt, its model, and its reasoning effort editable from Logfire.

Codex is a process wrapper rather than an in-process agent framework, and that decides what an adapter can offer. Everything the model sees is assembled inside the `codex` binary from `config.toml`, the `-c key=value` overrides the SDK forwards, and files on disk — so the prompt and the model are manageable, and the tools, which the binary defines and never sends from the client, are not.

## Install

```bash
npm install @pydantic/logfire-agent-control-codex-sdk @openai/codex-sdk @pydantic/logfire-node
```

Both `@openai/codex-sdk` and `@pydantic/logfire-node` are peer dependencies, so your project owns the versions: the adapter has to use the copy of the SDK your code builds threads with, and the copy of Logfire your code configured.

## Usage

Wrap the options you already pass to `new Codex(...)` and `startThread(...)`, and give the agent a name:

```ts
import { agentControl } from '@pydantic/logfire-agent-control-codex-sdk'
import * as logfire from '@pydantic/logfire-node'

logfire.configure()

const managed = agentControl({
  name: 'ci_fixer',
  codex: { config: { developer_instructions: 'Fix CI without changing public APIs.' } },
  thread: { model: 'gpt-5.6-sol', modelReasoningEffort: 'medium', sandboxMode: 'workspace-write' },
})

const answer = await managed.run(async (thread) => {
  const turn = await thread.run('Diagnose and fix the failing CI job.')
  return turn.finalResponse
})
```

`name` is required and is never inferred: it is what picks out the `agent__<name>` variable, and Codex has no agent name of its own to derive one from.

`run` is the form to reach for. It starts the thread with the published config applied and holds the resolution's telemetry context open for the callback, so every span your own code opens around the turn carries the label the config was resolved under. `startThread`, `resumeThread`, and `resolveOptions` apply the same config without that scope, and `baseline()` returns the document describing your code without publishing it.

On construction, the agent as written is published to the variable's `example`, which is what the Logfire editor shows a managed value being layered onto. Pass `publishBaseline: false` when the token is intentionally read-only.

## What is editable

| Published                                                        | Applies as                                                    | Support                                                                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `instructions` entry with id `developer_instructions`            | `-c developer_instructions=`                                  | Yes                                                                                                 |
| `instructions` entry with no id                                  | joined onto the developer message                             | Yes                                                                                                 |
| `instructions` entry with id `base_instructions`                 | `-c model_instructions_file=` pointing at a private temp file | Yes, and it replaces Codex's _entire_ built-in system prompt                                        |
| `model`                                                          | the `--model` slug plus `-c model_provider=`                  | Yes                                                                                                 |
| `settings.thinking`                                              | `-c model_reasoning_effort=`                                  | `minimal`, `low`, `medium`, `high`, `xhigh`; the provider has the last word per model               |
| `agents_md`, `host_skills`, `permissions`, `environment_context` | —                                                             | No. Codex assembles them per session; they are published as seams so the editor can show they exist |
| every other `settings` key                                       | —                                                             | No. Codex exposes a reasoning effort, not a sampler                                                 |
| `tool_definitions`                                               | —                                                             | No. Codex defines its tools inside its own binary                                                   |

Everything in the last three rows is reported through the control's `onUnmatched` policy rather than dropped in silence, so Logfire never shows a value the agent is quietly ignoring.

## When the config applies

**Per thread, at thread start.** There is no per-request hook to install and no per-turn config, so the published value is read once — when `run` / `startThread` / `resumeThread` / `resolveOptions` is called — and lowered into the options that start the `codex` process. A second turn on a `Thread` you kept runs on what that thread was started with.

Resuming is the one place where Codex and the contract disagree. `resumeThread` re-sends every override, and Codex takes the model and the reasoning effort but replays the developer message it persisted with the session, so a **changed instruction reaches new threads only**.

Per-call overrides win over the published config, which wins over the options the agent was constructed with. The model is the one value that is more than a per-key merge: a published `ollama:qwen3` sets both the slug and `model_provider`, and if the call passes its own `model`, the published provider is dropped along with the model it qualified rather than left behind to send that model somewhere it has never been heard of.

See the [package README](https://github.com/pydantic/logfire-js/blob/main/packages/logfire-agent-control-codex-sdk/README.md) for the full table, the baseline, and the known limits.

## Related Guides

- [Agent Control](../agent-control.md)
- [Managed Variables](../managed-variables.md)
- [Node.js](../packages/node.md)
