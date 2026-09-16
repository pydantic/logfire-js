/**
 * What the Logfire editor is shown: the baseline this adapter publishes for a Codex agent.
 *
 * The exact JSON matters more here than in most tests. It is the document someone edits, so a block
 * that is missing from it is a block nobody knows they can change, and a block whose text is
 * published is text that anyone who can read the project can read.
 */

import { dirname } from 'node:path'

import { describe, expect, it } from 'vite-plus/test'

import { agentControl } from '../index'
import { captureWarnings, settle, storedConfig, tempFile, uniqueName, useLocalVariables } from './helpers'

const warnings = captureWarnings()

describe('the published baseline', () => {
  it('describes the writable blocks, the Codex-owned ones as seams, the model, and the effort', async () => {
    const name = uniqueName()
    useLocalVariables()
    const managed = agentControl({
      name,
      codex: { config: { developer_instructions: 'Fix CI without changing public APIs.' } },
      thread: { model: 'gpt-5.6-sol', modelReasoningEffort: 'medium', sandboxMode: 'workspace-write' },
    })

    const baseline = {
      instructions: [
        { id: 'developer_instructions', instructions: 'Fix CI without changing public APIs.', dynamic: false },
        { id: 'host_skills', dynamic: true },
        { id: 'permissions', dynamic: true },
        { id: 'agents_md', dynamic: true },
        { id: 'environment_context', dynamic: true },
      ],
      model: 'gpt-5.6-sol',
      settings: { thinking: 'medium' },
    }
    expect(managed.baseline()).toEqual(baseline)
    // No `tool_definitions`: Codex's tools are defined in the binary, and a section describing none
    // of them would read as "this agent has no tools".
    expect(Object.keys(managed.baseline())).toEqual(['instructions', 'model', 'settings'])

    await settle()
    const stored = storedConfig(`agent__${name}`)
    expect(stored?.example).toBe(JSON.stringify(baseline, null, 2))
    // Created with the contract's schema, which is what makes the variable editable in Logfire.
    expect(stored?.json_schema).toBeDefined()
  })

  it('publishes the base prompt only when the code replaced it, and reads it off disk', () => {
    const file = tempFile('base.md', 'You are a release bot.')
    const managed = agentControl({
      name: uniqueName(),
      codex: { config: { model_instructions_file: file } },
      publishBaseline: false,
    })
    expect(managed.baseline().instructions).toContainEqual({
      id: 'base_instructions',
      instructions: 'You are a release bot.',
      dynamic: false,
    })

    // Nothing replaced it, so the built-in prompt is not offered as an empty box to overwrite.
    const builtIn = agentControl({ name: uniqueName(), publishBaseline: false })
    expect(JSON.stringify(builtIn.baseline())).not.toContain('base_instructions')
  })

  it("expands a leading `~` the way Codex does, so a home-relative prompt is not 'unreadable'", () => {
    // Codex reads `~/base.md`; `resolve` would have joined the `~` onto the working directory and
    // this package would have warned about a file that is perfectly readable, and published a
    // baseline missing the one block the agent replaced.
    const file = tempFile('base.md', 'You are a release bot.')
    const home = process.env['HOME']
    process.env['HOME'] = dirname(file)
    try {
      const managed = agentControl({
        name: uniqueName(),
        codex: { config: { model_instructions_file: '~/base.md' } },
        publishBaseline: false,
      })
      expect(managed.baseline().instructions).toContainEqual({
        id: 'base_instructions',
        instructions: 'You are a release bot.',
        dynamic: false,
      })
      expect(warnings.messages).toEqual([])
    } finally {
      process.env['HOME'] = home
    }
  })

  it('says so when the base prompt cannot be read, and publishes the rest', () => {
    const managed = agentControl({
      name: uniqueName(),
      codex: { config: { model_instructions_file: 'no/such/base.md' } },
      thread: { workingDirectory: '/tmp' },
      publishBaseline: false,
    })
    expect(warnings.messages.join('\n')).toContain('/tmp/no/such/base.md')
    expect(JSON.stringify(managed.baseline())).not.toContain('base_instructions')
  })

  it('leaves out a reasoning effort the contract cannot express', () => {
    // Codex has `max`, `ultra`, and `persistent`; the contract's `thinking` does not, and a baseline
    // carrying one would not validate against the schema the variable is created with.
    const managed = agentControl({
      name: uniqueName(),
      thread: { model: 'gpt-5.6-sol', modelReasoningEffort: 'ultra' },
      publishBaseline: false,
    })
    expect(managed.baseline().settings).toBeUndefined()
    expect(managed.baseline().model).toBe('gpt-5.6-sol')
  })

  it('reports the provider the code pinned, not the default one', () => {
    const managed = agentControl({
      name: uniqueName(),
      codex: { config: { model_provider: 'ollama' } },
      thread: { model: 'qwen3' },
      publishBaseline: false,
    })
    expect(managed.baseline().model).toBe('ollama:qwen3')
  })

  it('reads the model and the effort from `codex.config` when the thread names neither', () => {
    const managed = agentControl({
      name: uniqueName(),
      // Where an agent that pins one model for every thread it starts writes it. Both keys lower to
      // `-c` flags, so a baseline that only read `ThreadOptions` described this agent as having no
      // model and no effort at all -- and publishing either one back would have looked like a change
      // when it was the code all along.
      codex: { config: { model: 'qwen3', model_provider: 'ollama', model_reasoning_effort: 'high' } },
      publishBaseline: false,
    })
    expect(managed.baseline().model).toBe('ollama:qwen3')
    expect(managed.baseline().settings).toEqual({ thinking: 'high' })
  })

  it('prefers the thread over `codex.config`, which is the order Codex applies them in', () => {
    // `thread.model` becomes `--model`, which beats `-c model=`; `thread.modelReasoningEffort`
    // becomes the last `-c model_reasoning_effort=` flag, and the last `-c` wins. Both verified
    // against codex-cli 0.153.4.
    const managed = agentControl({
      name: uniqueName(),
      codex: { config: { model: 'qwen3', model_reasoning_effort: 'high' } },
      thread: { model: 'gpt-5.6-sol', modelReasoningEffort: 'low' },
      publishBaseline: false,
    })
    expect(managed.baseline().model).toBe('gpt-5.6-sol')
    expect(managed.baseline().settings).toEqual({ thinking: 'low' })
  })

  it('leaves out a `codex.config` effort the contract cannot express, and a model that is not a slug', () => {
    const managed = agentControl({
      name: uniqueName(),
      codex: { config: { model: 42, model_reasoning_effort: 'persistent' } },
      publishBaseline: false,
    })
    expect(managed.baseline().model).toBeUndefined()
    expect(managed.baseline().settings).toBeUndefined()
  })

  it('publishes nothing at all for an agent whose options say nothing', () => {
    const managed = agentControl({ name: uniqueName(), publishBaseline: false })
    // Every block Codex owns is still a seam, so the editor can show what it cannot change.
    expect(managed.baseline()).toEqual({
      instructions: [
        { id: 'host_skills', dynamic: true },
        { id: 'permissions', dynamic: true },
        { id: 'agents_md', dynamic: true },
        { id: 'environment_context', dynamic: true },
      ],
    })
  })

  it('does not publish when asked not to', async () => {
    const name = uniqueName()
    useLocalVariables()
    agentControl({ name, publishBaseline: false, thread: { model: 'gpt-5.6-sol' } })
    await settle()
    expect(storedConfig(`agent__${name}`)).toBeUndefined()
  })
})

describe('the agent name', () => {
  it('is required, because Codex has none of its own to derive one from', () => {
    expect(() => agentControl({ name: '  ' })).toThrow(/needs an explicit `name`/u)
    expect(() => agentControl({} as unknown as { name: string })).toThrow(/needs an explicit `name`/u)
  })

  it('picks out the agent variable, and carries the label and policy through', () => {
    const managed = agentControl({
      name: 'ci_fixer',
      label: 'staging',
      onUnmatched: 'ignore',
      publishBaseline: false,
    })
    expect(managed.control.variableName).toBe('agent__ci_fixer')
    expect(managed.control.label).toBe('staging')
    expect(managed.control.onUnmatched).toBe('ignore')
  })
})
