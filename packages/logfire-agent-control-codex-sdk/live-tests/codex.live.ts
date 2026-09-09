/**
 * The live suite: this adapter, a real `codex` process, and a real model.
 *
 * The offline suite in `src/__test__` proves the mapping from a published value to the flags a
 * `codex` process is started with, against a stand-in binary that records its argv. What it cannot
 * prove is what the *model* then sees, because the prompt is assembled inside the binary and sent
 * from there. Three claims this package makes are about exactly that, and each of the tests below
 * exists to settle one of them:
 *
 * 1. a published `developer_instructions` block really does change what the model is told, and a
 *    published `settings.thinking` is really accepted by the provider rather than 400'd;
 * 2. `codex exec resume` does *not* re-inject a changed developer block into a session that already
 *    persisted one -- which is why the README tells you to treat a published change as something new
 *    threads pick up;
 * 3. a published `model` whose provider id is not `openai` reaches that provider, rather than being
 *    a flag Codex parses and ignores.
 *
 * This file is deliberately not a `.test.ts` and is not in the default `vp test` include, so CI
 * never runs it: it needs a `codex` on the machine, a logged-in account, and (for the third test) an
 * OpenAI API key. See `live-tests/README.md`.
 */

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CodexOptions, SandboxMode, ThreadOptions } from '@openai/codex-sdk'
import { configureVariables } from '@pydantic/logfire-node/vars'
import { resetAgentControl } from '@pydantic/logfire-node/agent-control/testing'
import { beforeEach, describe, expect, it } from 'vite-plus/test'

import { agentControl } from '../src/index'

/**
 * Whether the machine has a Codex account these turns can run on.
 *
 * The binary itself is not in question -- `@openai/codex-sdk` vendors one and the SDK resolves it
 * without any help -- so the thing that decides whether a live turn is possible is `codex login`,
 * which writes an `auth.json` into the Codex home.
 */
function isLoggedIn(): boolean {
  return existsSync(join(process.env['CODEX_HOME'] ?? join(homedir(), '.codex'), 'auth.json'))
}

const LOGGED_IN = isLoggedIn()
const OPENAI_API_KEY = process.env['OPENAI_API_KEY']

/**
 * The model every test here runs on.
 *
 * A small current model rather than the flagship the README names: these turns exist to prove a
 * flag arrives, not to measure an agent. Override it when a machine's account cannot reach this one.
 */
const MODEL = process.env['CODEX_LIVE_MODEL'] ?? 'gpt-5.6-sol'

/**
 * The sandbox every test here runs under.
 *
 * `read-only` by default, because nothing in this suite has any business writing to the machine.
 * Codex's sandbox is a user namespace, which some containers refuse to create; where it cannot
 * start, set this to the mode that machine's own `config.toml` uses and let the container be the
 * boundary instead.
 */
const SANDBOX_MODE = (process.env['CODEX_LIVE_SANDBOX_MODE'] ?? 'read-only') as SandboxMode

/** Two codewords no model has an opinion about, so the answer says which prompt reached it. */
const PUBLISHED_CODEWORD = 'ALPHA7'
const CODE_CODEWORD = 'OMEGA2'

/** An instruction whose only effect is to make the model repeat one word back. */
function codewordRule(codeword: string): string {
  return `Do not run any commands. When asked for the codeword, reply with exactly ${codeword} and nothing else.`
}

/** The prompt that asks for it. */
const ASK = 'What is the codeword?'

/** Publish `value` for `agent__<name>` in a local variables config, the way the UI would. */
function publish(name: string, value: unknown): void {
  configureVariables({
    instrument: false,
    config: {
      variables: {
        [`agent__${name}`]: {
          name: `agent__${name}`,
          labels: { production: { version: 1, serialized_value: JSON.stringify(value) } },
          rollout: { labels: { production: 1 } },
          overrides: [],
        },
      },
    },
  })
}

/** A distinct agent name per test, so no two share a variable. */
let counter = 0
function uniqueName(): string {
  counter += 1
  return `live_codex_${String(counter)}`
}

/** A scratch directory to run the turn in, so no test touches a repository. */
function scratchDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'agent-control-live-'))
}

/** The thread options every test starts from. */
function threadOptions(): ThreadOptions {
  return { model: MODEL, sandboxMode: SANDBOX_MODE, skipGitRepoCheck: true, workingDirectory: scratchDirectory() }
}

beforeEach(() => {
  resetAgentControl()
})

describe.skipIf(!LOGGED_IN)('a live Codex turn', () => {
  it('answers with the published developer instructions, not the ones in the code', async () => {
    const name = uniqueName()
    publish(name, {
      instructions: [{ id: 'developer_instructions', instructions: codewordRule(PUBLISHED_CODEWORD) }],
      // Lowered to `-c model_reasoning_effort=low` and sent to the provider on the same request, so
      // a turn that completes at all is a `thinking` the provider accepted.
      settings: { thinking: 'low' },
    })
    const managed = agentControl({
      name,
      codex: { config: { developer_instructions: codewordRule(CODE_CODEWORD) } },
      thread: threadOptions(),
      publishBaseline: false,
    })

    const answer = await managed.run(async (thread) => (await thread.run(ASK)).finalResponse)

    expect(answer.trim()).toBe(PUBLISHED_CODEWORD)
  })

  it('does not re-inject a changed developer block into a session it already persisted one for', async () => {
    // The one claim in the README that could not be read off Codex's source: `resumeThread` re-sends
    // every `-c` flag, so the *question* is whether the binary prefers the flag or the developer
    // message it wrote into the session file. The first turn is deliberately not about the codeword,
    // so an answer of ALPHA7 on resume cannot be the model repeating its own earlier reply.
    const started = uniqueName()
    publish(started, { instructions: [{ id: 'developer_instructions', instructions: codewordRule(PUBLISHED_CODEWORD) }] })
    const options = threadOptions()
    const first = agentControl({ name: started, thread: options, publishBaseline: false })
    const thread = await first.startThread()
    await thread.run('Reply with exactly READY and nothing else.')
    const id = thread.id
    expect(id).not.toBeNull()

    const resumed = uniqueName()
    publish(resumed, { instructions: [{ id: 'developer_instructions', instructions: codewordRule(CODE_CODEWORD) }] })
    const second = agentControl({ name: resumed, thread: options, publishBaseline: false })
    const answer = (await (await second.resumeThread(id as string)).run(ASK)).finalResponse

    // The session's own developer message wins. A published change is a new-thread affair.
    expect(answer.trim()).toBe(PUBLISHED_CODEWORD)
  })
})

describe.skipIf(OPENAI_API_KEY === undefined)('a live turn on a provider the machine defines itself', () => {
  it('sends a published non-`openai` provider id to that provider', async () => {
    // `model_provider` indexes into the `model_providers` table of the machine's `config.toml`, a
    // file this package never reads -- so "a published `ollama:qwen3` reaches Ollama" was, until
    // this test, an argument from the flag rather than an observation. A `CODEX_HOME` holding one
    // extra provider entry and no `auth.json` makes the observation: nothing but that entry can
    // serve the turn. That is also why this one is not under the login guard the others are: it
    // brings its own Codex home and its own credential, so a machine with only an API key runs it.
    const home = scratchDirectory()
    writeFileSync(
      join(home, 'config.toml'),
      [
        '[model_providers.openai_direct]',
        'name = "OpenAI direct"',
        'base_url = "https://api.openai.com/v1"',
        'env_key = "OPENAI_API_KEY"',
        'wire_api = "responses"',
        '',
      ].join('\n'),
      'utf8'
    )

    const name = uniqueName()
    publish(name, {
      instructions: [{ id: 'developer_instructions', instructions: codewordRule(PUBLISHED_CODEWORD) }],
      model: `openai_direct:${MODEL}`,
    })
    // `env` replaces the child's environment wholesale rather than adding to it, so everything the
    // CLI needs is named here and nothing else leaks in.
    const codex: CodexOptions = {
      env: {
        CODEX_HOME: home,
        HOME: home,
        OPENAI_API_KEY: OPENAI_API_KEY ?? '',
        PATH: process.env['PATH'] ?? '',
      },
    }
    const managed = agentControl({ name, codex, thread: threadOptions(), publishBaseline: false })

    const answer = await managed.run(async (thread) => (await thread.run(ASK)).finalResponse)

    expect(answer.trim()).toBe(PUBLISHED_CODEWORD)
  })
})
