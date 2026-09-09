# `@pydantic/logfire-agent-control-codex-sdk`

Agent Control lets someone change what a running [Codex SDK](https://developers.openai.com/codex/sdk)
agent does — its developer instructions, its base prompt, its model, its reasoning effort — from the
Logfire UI, without a deploy.

The agent's configuration lives in one Logfire variable named `agent__<name>`. Every value in it is a
_patch_ on the agent as written: a section that is present is managed from Logfire, a section that is
absent keeps what your code does, and deleting a section in Logfire is a deliberate revert to code.
If Logfire is unreachable, if nothing has been published, or if a published value cannot be
understood, the agent runs exactly as your code defines it.

**Prerequisites.** Node 20+, ESM, the `codex` CLI on the machine, and a Logfire project. Both
`@openai/codex-sdk` and `@pydantic/logfire-node` are peer dependencies you install yourself — the
first because this package must use the copy of the SDK your code builds threads with, the second
because Logfire's variable provider is a module-level singleton and a second copy of it would read a
different one. Nothing here reads an environment variable of its own: the Logfire SDK's own
configuration decides where the variable is read from — `logfire.configure({ apiKey })` or
`LOGFIRE_API_KEY`, with `LOGFIRE_BASE_URL` naming the region. An API key is what remote variables
need; `LOGFIRE_TOKEN` is the write token for spans and does not resolve one.

```bash
npm install @pydantic/logfire-agent-control-codex-sdk @openai/codex-sdk @pydantic/logfire-node
```

## Quick start

Wrap the options you already pass to `new Codex(...)` and `startThread(...)`, and give the agent a
name:

```ts
import * as logfire from '@pydantic/logfire-node'
import { agentControl } from '@pydantic/logfire-agent-control-codex-sdk'

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

`run` is the form to reach for: it starts the thread with the published config applied and holds the
resolution's telemetry context open for the callback, so every span your code opens around the turn
carries the label the config was resolved under — the difference between "this agent regressed" and
"this agent regressed on the value someone published at 14:02". The `codex` child process itself is
not something this package can instrument.

`name` is required and is not derived from anything: it is what picks out the variable, and Codex has
no agent name of its own to take one from. It is normalized to the variable key by the core's rule —
lowercased, everything outside `[a-z0-9_]` replaced with `_` — so `ci_fixer`, `CI Fixer`, and
`ci-fixer` are all `agent__ci_fixer`.

## The factory

```ts
agentControl(options: CodexAgentControlOptions): ManagedCodex
```

Constructs nothing of the SDK's: it holds your options, publishes the baseline once, and hands back a
`ManagedCodex`. Your own `CodexOptions` and `ThreadOptions` objects are never mutated — every call
copies them before applying anything.

| Option            | Meaning                                                                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name` (required) | Picks out the `agent__<name>` variable.                                                                                                                                                              |
| `codex`           | The options you would have passed to `new Codex(...)`.                                                                                                                                               |
| `thread`          | The options you would have passed to `startThread(...)` / `resumeThread(...)`.                                                                                                                       |
| `label`           | Read this label instead of letting the variable's rollout choose one.                                                                                                                                |
| `onUnmatched`     | What to do about a published entry that reaches nothing: `'warn'` (default, once per distinct message per process), `'ignore'`, or `'error'`, which throws `UnmatchedConfigError` and fails the run. |
| `publishBaseline` | `false` when the Logfire token is read-only, or code must not write variable metadata.                                                                                                               |

`ManagedCodex` has four ways to run and one to look:

| Method                         | Returns                                                       | Resolution's telemetry context   |
| ------------------------------ | ------------------------------------------------------------- | -------------------------------- |
| `run(fn, overrides?)`          | whatever `fn` returns                                         | open for the whole of `fn`       |
| `startThread(overrides?)`      | the SDK's `Thread`                                            | closed before you use the thread |
| `resumeThread(id, overrides?)` | the SDK's `Thread`                                            | closed before you use the thread |
| `resolveOptions(overrides?)`   | `{ codex, thread }`, for code that builds its own `Codex`     | closed before you build it       |
| `baseline()`                   | the `AgentConfig` describing your code, without publishing it | —                                |

`control` is the underlying `AgentControl`, exposed for its `name`, `variableName`, `label`, and
`onUnmatched`.

## What becomes editable in Logfire

| Source / canonical field                                                                                                                                    | Block id or runtime mapping                                      | Support         | Conditions and unmatched behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex.config.developer_instructions`                                                                                                                       | `developer_instructions` → `-c developer_instructions=`          | **Yes**         | Rewrites the developer message. Removing the block sends `developer_instructions=""`, which Codex reads as none — a dropped flag would instead expose the `developer_instructions` in the machine's `config.toml`.                                                                                                                                                                                                                                                                                             |
| An entry with no `id`                                                                                                                                       | joined onto `developer_instructions`                             | **Yes**         | Appended after your own text, in the order published; nothing moves ahead of it, so a cached prompt prefix stays cached. Works for an agent whose code sets no developer instructions at all.                                                                                                                                                                                                                                                                                                                  |
| `codex.config.model_instructions_file`                                                                                                                      | `base_instructions` → `-c model_instructions_file=<temp file>`   | **Conditional** | Published text replaces Codex's **entire** built-in system prompt, including the parts that tell it how to use `apply_patch` and its shell. It is written to a private temp file, since Codex takes a path. Shown in the baseline only when your code already sets `model_instructions_file`; publish it by id otherwise. Removing the block stops this package from overriding the prompt, but cannot reset one set in `config.toml` — Codex has no key for that, so the gap is reported under `onUnmatched`. |
| Codex's own prompt pieces                                                                                                                                   | `agents_md`, `host_skills`, `permissions`, `environment_context` | **No**          | Assembled inside the binary per session from the repository and the machine. They are in the baseline as seams so the editor can show they exist; an entry addressing one is reported and not applied. `AGENTS.md` is editable by committing to it.                                                                                                                                                                                                                                                            |
| `model`                                                                                                                                                     | `--model` slug, plus `-c model_provider=`                        | **Yes**         | `openai:gpt-5.6-sol` is the model and `openai` the provider entry it is looked up under; a bare `gpt-5.6-sol` leaves your provider alone. A provider other than the default must exist in your `config.toml` `model_providers` table, and Codex only speaks the Responses API. A per-call `overrides.model` wins, and then the published provider is **not** applied either — see [Precedence](#precedence).                                                                                                   |
| `settings.thinking`                                                                                                                                         | `-c model_reasoning_effort=`                                     | **Conditional** | `minimal`, `low`, `medium`, `high`, `xhigh` apply. `thinking: true` / `false` has no Codex meaning and is reported. Codex's own `max`, `ultra`, and `persistent` are outside the contract: set them in your code and they stay, but they are not published as a baseline. Codex forwards the effort verbatim and the provider has the last word on it, per model: `gpt-5.6-sol` answers `minimal` with a 400 naming the values it does take.                                                                   |
| `settings.max_tokens`, `temperature`, `top_p`, `top_k`, `seed`, `presence_penalty`, `frequency_penalty`, `parallel_tool_calls`, `stop_sequences`, `timeout` | —                                                                | **No**          | Codex has no config key for any of them; each published key is reported under `onUnmatched`. It is a coding-agent runtime: what it exposes is reasoning effort, not a sampler.                                                                                                                                                                                                                                                                                                                                 |
| `tool_definitions` (rename, description, parameter descriptions)                                                                                            | —                                                                | **No**          | Codex defines its tools inside its own binary. `shell`, `apply_patch`, `update_plan`, web search, and MCP tools are never sent by a client, so there is nothing to reword; each override is reported.                                                                                                                                                                                                                                                                                                          |

`'warn'` (the default) prints each distinct report once per process, `'error'` turns it into a thrown
`UnmatchedConfigError`, and `'ignore'` says nothing.

## Resolution, baseline, precedence

### When the config applies

**Per thread, at thread start.** Codex is a process wrapper: everything the model sees is assembled
inside the `codex` binary from `config.toml`, the `-c key=value` overrides the SDK forwards, and files
on disk. There is no per-request hook to install and no per-turn config, so the published value is
read once, when `run` / `startThread` / `resumeThread` / `resolveOptions` is called, and lowered into
the options that start the process.

A turn on an already-started thread runs with what its thread was started with. That includes a
`Thread` you keep: `await thread.run(...)` a second time is a second turn on the options the first
resolution produced, and reusing a `Thread` never re-reads the config. Call `run` again — or start a
new thread — to pick up a change.

Resuming re-sends every override as a flag on the new process, but a **changed developer block does
not reach the model on a resumed session**: `codex exec resume` replays the developer message the
session already persisted, and the `-c developer_instructions=` this package sends is ignored.
Observed against codex-cli 0.153.4 and pinned by `live-tests/codex.live.ts`, which starts a session
under one published instruction, publishes another, resumes, and gets the first one back. So a
published change is something _new threads_ pick up; `resumeThread` still applies a published model
and reasoning effort, which the CLI does take per turn.

### Precedence

Code < published < the options you pass to this call. `agentControl({ thread })` is the code layer,
the Logfire value is the published layer, and `run(fn, overrides)` / `startThread(overrides)` /
`resumeThread(id, overrides)` / `resolveOptions(overrides)` are the per-call layer. Because those
overrides are a bag you pass at the call site, this adapter knows exactly which keys a call set —
there is no diffing and no guessing — and a call that explicitly passes the same value its code
declares still beats a published one.

The one place that is more than a per-key merge is the model, because Codex splits it in two. A
published `ollama:qwen3` sets both the slug and `model_provider`; if the same call passes its own
`model`, the published model loses, and its provider is dropped with it rather than left behind to
send your model to somebody else's endpoint.

### The baseline

On construction, the agent as written is published to the variable's `example` — what the Logfire
editor shows a managed value being layered onto — and, if the variable does not exist yet, it is
created with the contract's JSON schema, which is what makes it editable at all. Everything a Codex
agent is, it is at construction, so this needs no first request and the baseline is `source: 'code'`
rather than a snapshot of one run.

What it contains: the two writable blocks (`base_instructions` only when your code replaced the
built-in prompt, read off the file you pointed at), the four Codex-owned blocks as ids with no text,
the model, and the reasoning effort. The model and effort are read from `thread` first and from
`codex.config` otherwise, since an agent may pin either in either place; `thread` wins because that is
the order Codex applies them in. A provider is published only when your code pins one — an
unqualified slug is published unqualified, because the provider a bare slug resolves to lives in a
`config.toml` this package cannot read, and inventing `openai` would describe an identity the run need
not have.

What it does not contain: the config keys you set for anything else (`mcp_servers`, `sandbox_mode`,
`model_verbosity`), any text Codex computes inside the binary, and any `tool_definitions` section —
a section describing none of Codex's tools would read as "this agent has no tools".

Publishing is at most once per process per variable, off the request path, and never fails a run.
Updating an existing variable is read-modify-write over the whole definition, so a value or label
saved in the Logfire UI inside that one round trip can be overwritten; pass `publishBaseline: false`
and create the variable in the UI if you cannot tolerate that window.

## Renames, permissions, and history

**Tool renames do not exist here.** A `tool_definitions` entry is reported and nothing is renamed, so
the question of whether your code, your hooks, or a resumed session see the old name or the new one
does not arise. Codex's session history is written by the binary and is never rewritten by this
package.

The one tool control Codex does have is allow-listing (`mcp_servers.<id>.enabled_tools`, per-tool
`approval_mode`), which is not part of this contract: set it in your own `codex.config` and it is
carried through untouched, like every other key this contract says nothing about.

## Known limits

- **Per thread, not per turn**, and a reused `Thread` does not re-read the config — see above.
- **Your `codex.configOverrides` win.** Raw `-c` strings are passed to the CLI after the structured
  `config` this package writes, and the last `-c` for a key wins, so a raw `developer_instructions=…`
  there beats a published one. Set instructions through `config`, not `configOverrides`.
- **A removed base prompt cannot be reset.** Removing `base_instructions` stops this package from
  sending `model_instructions_file`, but Codex has no config value that resets one — an empty value is
  a path it fails the run trying to read — so a `model_instructions_file` in the machine's own
  `config.toml` still replaces the built-in prompt. That gap is reported under `onUnmatched` rather
  than papered over.
- **A published base prompt is written to a temp file** (mode 0600, in a per-process directory removed
  at exit) because Codex takes it as a path rather than as text. One file per distinct prompt, written
  once and never rewritten, so a `codex` process reading it never sees a half-written file.
- **Codex's model is invisible when your code names one in neither `thread` nor `codex.config`.** It
  falls back to `config.toml`, which this package does not read, so the baseline names no model and
  publishing one is how you get it back.
- **The `codex` process is not instrumented.** Only the spans your own code opens carry the resolved
  label.
- **Node only, ESM only.**

## Compared with an in-process agent framework

If you are choosing where to run an agent you want to manage from Logfire, this is the difference in
one line: **on the Codex SDK, Agent Control is a managed prompt and a model switch; on a framework
that hands an adapter the agent itself — Mastra, the Vercel AI SDK, Pydantic AI — it is the whole
feature.**

Those frameworks give an adapter an agent object with its own instructions, tools, model, and model
settings, plus a per-request hook — so all four sections apply per model request, a renamed tool
routes back to your function, tool descriptions and parameter descriptions are editable, and
`temperature` and the rest lower onto real fields. Codex gives an adapter a command line. What you
gain here is hot-swapping the model, the reasoning effort, and the developer instructions (or the
whole system prompt) without a redeploy. What you do not gain is any control over tool wording or
sampling.

## Development

This package lives in the [`logfire-js`](https://github.com/pydantic/logfire-js) monorepo and uses its
toolchain. From the repository root:

```bash
vp install
vp run @pydantic/logfire-agent-control-codex-sdk#test        # offline, what CI runs
vp run @pydantic/logfire-agent-control-codex-sdk#typecheck
vp check                                                     # format and lint, whole repo
```

The offline suite runs against a local variables provider and a stand-in `codex` binary
(`test-fixtures/fake-codex.ts`) that records the argv it was started with — so the mapping from a
published value to real CLI flags is asserted end to end, with no API key and no model.

`live-tests/` is the other half, and it is not in the default `vp test` include, so CI never runs it:
it drives a real `codex` against a real model to settle the three claims a recorder cannot, because
Codex assembles its prompt inside a binary that no JS HTTP recorder sits in front of. See
[`live-tests/README.md`](live-tests/README.md).

Where this README states what the `codex` binary itself does with a flag, it was checked against
codex-cli 0.153.4 with `codex debug prompt-input` or by a test in `live-tests/`.
