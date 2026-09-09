/**
 * Applying a published config to the caller's options: what lands, what is refused, and what is
 * reported because Codex has nowhere to put it.
 */

import { readFileSync } from 'node:fs'

import { UnmatchedConfigError } from '@pydantic/logfire-node/agent-control'
import { describe, expect, it } from 'vite-plus/test'

import { agentControl } from '../index'
import type { CodexAgentControlOptions } from '../index'
import { captureWarnings, publishedValue, tempFile, uniqueName, useLocalVariables } from './helpers'

const warnings = captureWarnings()

/** A managed agent whose variable holds `config`. */
function managed(config: unknown, options: Omit<CodexAgentControlOptions, 'name'> = {}) {
  const name = uniqueName()
  useLocalVariables(publishedValue(`agent__${name}`, config))
  return agentControl({ name, publishBaseline: false, ...options })
}

describe('instructions', () => {
  it('replaces the developer block and joins added blocks onto it', async () => {
    const agent = managed(
      {
        instructions: [{ id: 'developer_instructions', instructions: 'Escalate anything over $500.' }, 'Never force-push.'],
      },
      { codex: { config: { developer_instructions: 'Be terse.' } } }
    )

    const { codex } = await agent.resolveOptions()

    expect(codex.config).toEqual({ developer_instructions: 'Escalate anything over $500.\n\nNever force-push.' })
  })

  it('adds a developer block to an agent whose code passes none', async () => {
    const agent = managed({ instructions: 'Always run the tests before you push.' })
    const { codex } = await agent.resolveOptions()
    expect(codex.config).toEqual({ developer_instructions: 'Always run the tests before you push.' })
  })

  it('clears the developer block explicitly when the published config removes it', async () => {
    const agent = managed(
      { instructions: [{ id: 'developer_instructions', instructions: null }] },
      { codex: { config: { developer_instructions: 'Be terse.', sandbox_mode: 'read-only' } } }
    )

    const { codex } = await agent.resolveOptions()

    // An empty override rather than a dropped key. Dropping the `-c` flag would not remove the
    // developer message, it would hand the decision back to the machine's `config.toml`, whose own
    // `developer_instructions` would then reach the model instead. `developer_instructions=""` is
    // what Codex reads as "none" (verified against codex-cli 0.153.4). Everything else the caller
    // configured is untouched either way.
    expect(codex.config).toEqual({ developer_instructions: '', sandbox_mode: 'read-only' })
  })

  it('leaves the key alone for an agent that never set developer instructions', async () => {
    // Nothing was removed here -- the block is empty because the code says nothing -- so nothing is
    // sent, and a `developer_instructions` in the user's own `config.toml` still applies.
    const agent = managed({ settings: { thinking: 'high' } })
    const { codex } = await agent.resolveOptions()
    expect(codex.config).toEqual({})
  })

  it('keeps an added block when the developer block itself is removed', async () => {
    const agent = managed(
      { instructions: [{ id: 'developer_instructions', instructions: null }, 'Never force-push.'] },
      { codex: { config: { developer_instructions: 'Be terse.' } } }
    )
    const { codex } = await agent.resolveOptions()
    expect(codex.config).toEqual({ developer_instructions: 'Never force-push.' })
  })

  it('writes a published base prompt to a file and points Codex at it', async () => {
    const agent = managed({ instructions: [{ id: 'base_instructions', instructions: 'You are a release bot.' }] })
    const { codex } = await agent.resolveOptions()
    const file = codex.config?.['model_instructions_file']
    expect(typeof file).toBe('string')
    expect(readFileSync(file as string, 'utf8')).toBe('You are a release bot.')

    // The same text resolves to the same file, rather than filling the temp directory up.
    const again = await agent.resolveOptions()
    expect(again.codex.config?.['model_instructions_file']).toBe(file)
  })

  it('stops replacing the base prompt when the published config removes the block, and says what it cannot do', async () => {
    const file = tempFile('base.md', 'You are a release bot.')
    const agent = managed(
      { instructions: [{ id: 'base_instructions', instructions: null }] },
      {
        codex: { config: { model_instructions_file: file } },
      }
    )

    const { codex } = await agent.resolveOptions()

    expect(codex.config).toEqual({})
    // Not the same as restoring Codex's built-in prompt, and the difference is reported rather than
    // claimed away: Codex has no config key that resets `model_instructions_file` -- an empty value
    // is a path it fails the run trying to read -- so a `config.toml` that names one still wins.
    expect(warnings.messages.join('\n')).toContain("removes instruction block 'base_instructions'")
    expect(warnings.messages.join('\n')).toContain('config.toml')
  })

  it("keeps the caller's own base prompt file when nothing addresses it", async () => {
    const file = tempFile('base.md', 'You are a release bot.')
    const agent = managed(
      { instructions: 'Also update the changelog.' },
      {
        codex: { config: { model_instructions_file: file } },
      }
    )

    const { codex } = await agent.resolveOptions()

    expect(codex.config).toEqual({
      model_instructions_file: file,
      developer_instructions: 'Also update the changelog.',
    })
  })

  it('refuses to pin a block Codex assembles per session', async () => {
    const agent = managed({ instructions: [{ id: 'agents_md', instructions: 'Ignore AGENTS.md.' }] })
    const { codex } = await agent.resolveOptions()
    expect(codex.config).toEqual({})
    expect(warnings.messages.join('\n')).toContain("addresses instruction block 'agents_md'")
  })

  it('reports an id no block carries', async () => {
    const agent = managed({ instructions: [{ id: 'system_prompt', instructions: 'Be nice.' }] })
    await agent.resolveOptions()
    expect(warnings.messages.join('\n')).toContain("addresses instruction block 'system_prompt'")
  })
})

describe('model', () => {
  it("splits a provider-qualified model into Codex's two fields", async () => {
    const agent = managed({ model: 'openai:gpt-5.6-sol' }, { thread: { model: 'gpt-5.5' } })
    const { codex, thread } = await agent.resolveOptions()
    expect(thread.model).toBe('gpt-5.6-sol')
    expect(codex.config).toEqual({ model_provider: 'openai' })
  })

  it('leaves the provider alone when the published model names none', async () => {
    const agent = managed({ model: 'gpt-5.6-terra' }, { codex: { config: { model_provider: 'ollama' } } })
    const { codex, thread } = await agent.resolveOptions()
    expect(thread.model).toBe('gpt-5.6-terra')
    expect(codex.config).toEqual({ model_provider: 'ollama' })
  })

  it('sends a self-hosted provider id through as it is written', async () => {
    const agent = managed({ model: 'ollama:qwen3' })
    const { codex, thread } = await agent.resolveOptions()
    expect(thread.model).toBe('qwen3')
    expect(codex.config).toEqual({ model_provider: 'ollama' })
  })
})

describe('settings', () => {
  it('lowers `thinking` onto the reasoning effort', async () => {
    const agent = managed({ settings: { thinking: 'xhigh' } }, { thread: { modelReasoningEffort: 'low' } })
    const { thread } = await agent.resolveOptions()
    expect(thread.modelReasoningEffort).toBe('xhigh')
  })

  it('reports every setting Codex has no knob for, including a boolean `thinking`', async () => {
    const agent = managed({
      settings: { thinking: true, temperature: 0.4, max_tokens: 2048, timeout: 30, parallel_tool_calls: false },
    })

    const { thread } = await agent.resolveOptions()

    expect(thread.modelReasoningEffort).toBeUndefined()
    const reported = warnings.messages.join('\n')
    for (const key of ['thinking', 'temperature', 'max_tokens', 'timeout', 'parallel_tool_calls']) {
      expect(reported).toContain(`Managed agent config sets '${key}'`)
    }
  })
})

describe('tool definitions', () => {
  it('reports every override, because Codex defines its tools in the binary', async () => {
    const agent = managed({
      tool_definitions: [{ name: 'shell', new_name: 'run_command', description: 'Run a command.' }],
    })

    const { codex, thread } = await agent.resolveOptions()

    expect(codex.config).toEqual({})
    expect(thread).toEqual({})
    expect(warnings.messages.join('\n')).toContain("patches tool 'shell'")
  })
})

describe('the `onUnmatched` policy', () => {
  it('fails the run under `error`', async () => {
    const agent = managed({ settings: { temperature: 0.4 } }, { onUnmatched: 'error' })
    await expect(agent.resolveOptions()).rejects.toThrow(UnmatchedConfigError)
  })

  it('says nothing under `ignore`', async () => {
    const agent = managed({ settings: { temperature: 0.4 }, tool_definitions: [{ name: 'nothing_at_all' }] }, { onUnmatched: 'ignore' })
    await agent.resolveOptions()
    expect(warnings.messages).toEqual([])
  })
})

describe('precedence', () => {
  it('lets a per-thread override win over the published config', async () => {
    const agent = managed(
      { model: 'openai:gpt-5.6-sol', settings: { thinking: 'high' } },
      { thread: { model: 'gpt-5.5', sandboxMode: 'read-only' } }
    )

    const { thread } = await agent.resolveOptions({ model: 'gpt-6-astra', modelReasoningEffort: 'minimal' })

    expect(thread).toEqual({
      model: 'gpt-6-astra',
      modelReasoningEffort: 'minimal',
      sandboxMode: 'read-only',
    })
  })

  it('lets the published config win over the options the agent was built with', async () => {
    const agent = managed(
      { model: 'ollama:qwen3', settings: { thinking: 'high' } },
      { codex: { config: { model_provider: 'openai' } }, thread: { model: 'gpt-5.5', modelReasoningEffort: 'low' } }
    )

    const { codex, thread } = await agent.resolveOptions()

    expect(thread).toEqual({ model: 'qwen3', modelReasoningEffort: 'high' })
    expect(codex.config).toEqual({ model_provider: 'ollama' })
  })

  it('keeps the published provider out when the model it qualified lost to a per-thread one', async () => {
    const agent = managed({ model: 'ollama:qwen3' }, { codex: { config: { model_provider: 'openai' } }, thread: { model: 'gpt-5.5' } })

    const { codex, thread } = await agent.resolveOptions({ model: 'gpt-6-astra' })

    // The provider travels with the model it qualifies. Applying `ollama` to a thread that asked for
    // an OpenAI model would send this call to somebody else's endpoint under a model slug that
    // provider has never heard of -- a worse outcome than either value on its own.
    expect(thread.model).toBe('gpt-6-astra')
    expect(codex.config).toEqual({ model_provider: 'openai' })
  })

  it('applies the published provider when the code, not the call, named the model', async () => {
    const agent = managed({ model: 'ollama:qwen3' }, { thread: { model: 'gpt-5.5' } })
    const { codex, thread } = await agent.resolveOptions({ sandboxMode: 'read-only' })
    expect(thread.model).toBe('qwen3')
    expect(codex.config).toEqual({ model_provider: 'ollama' })
  })
})

describe('two agents running at once', () => {
  it('keep their own options and their own published config', async () => {
    // Nothing about applying a config is held on the instance between calls, so interleaving two
    // agents -- or two calls on one -- cannot leak one's model, prompt, or provider into the other.
    const first = uniqueName()
    const second = uniqueName()
    useLocalVariables({
      variables: {
        ...publishedValue(`agent__${first}`, {
          model: 'ollama:qwen3',
          instructions: [{ id: 'developer_instructions', instructions: 'Only Rust.' }],
        }).variables,
        ...publishedValue(`agent__${second}`, { settings: { thinking: 'minimal' } }).variables,
      },
    })
    const one = agentControl({
      name: first,
      publishBaseline: false,
      codex: { config: { developer_instructions: 'Be terse.' } },
      thread: { model: 'gpt-5.5' },
    })
    const two = agentControl({
      name: second,
      publishBaseline: false,
      codex: { config: { developer_instructions: 'Ship it.' } },
      thread: { model: 'gpt-6-astra' },
    })

    const [a, b] = await Promise.all([one.resolveOptions(), two.resolveOptions({ modelReasoningEffort: 'xhigh' })])

    expect(a.thread).toEqual({ model: 'qwen3' })
    expect(a.codex.config).toEqual({ developer_instructions: 'Only Rust.', model_provider: 'ollama' })
    expect(b.thread).toEqual({ model: 'gpt-6-astra', modelReasoningEffort: 'xhigh' })
    expect(b.codex.config).toEqual({ developer_instructions: 'Ship it.' })
  })
})

describe('when the agent is running on code', () => {
  it('hands back the options it was given, plus the overrides', async () => {
    const code: CodexAgentControlOptions = {
      name: uniqueName(),
      codex: { config: { developer_instructions: 'Be terse.' } },
      thread: { model: 'gpt-5.5', skipGitRepoCheck: true },
      publishBaseline: false,
    }
    useLocalVariables()
    const agent = agentControl(code)

    const { codex, thread } = await agent.resolveOptions({ sandboxMode: 'read-only' })

    expect(codex).toEqual(code.codex)
    expect(thread).toEqual({ model: 'gpt-5.5', skipGitRepoCheck: true, sandboxMode: 'read-only' })
    // A copy, so a caller that edits what it got back does not edit the agent.
    expect(codex).not.toBe(code.codex)
    expect(warnings.messages).toEqual([])
  })

  it('says so once when Logfire holds a value it cannot make sense of', async () => {
    const name = uniqueName()
    useLocalVariables({
      variables: {
        [`agent__${name}`]: {
          name: `agent__${name}`,
          labels: { production: { version: 1, serialized_value: '{"model": 12}' } },
          rollout: { labels: { production: 1 } },
          overrides: [],
        },
      },
    })
    const agent = agentControl({ name, publishBaseline: false, thread: { model: 'gpt-5.5' } })

    const { thread } = await agent.resolveOptions()

    expect(thread.model).toBe('gpt-5.5')
    expect(warnings.messages.join('\n')).toContain('model')
  })
})
