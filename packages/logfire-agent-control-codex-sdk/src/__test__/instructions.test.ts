/**
 * The pieces with a life of their own: the temp file a managed base prompt lives in, and the model
 * string the contract and Codex disagree about the shape of.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { describe, expect, it } from 'vite-plus/test'

import { removeBaseInstructions, writeBaseInstructions } from '../instructions'
import { agentControl } from '../index'
import { joinModel, splitModel } from '../model'
import { captureWarnings, publishedValue, uniqueName, useLocalVariables } from './helpers'

captureWarnings()

describe('a managed base prompt on disk', () => {
  it('is written once per distinct text and cleaned up at exit', () => {
    // Nothing written yet, so there is nothing to clean up and saying so is not an error: this is
    // what the `exit` handler does in a process that never published a base prompt.
    removeBaseInstructions()

    const first = writeBaseInstructions('You are a release bot.')
    const other = writeBaseInstructions('You are a changelog bot.')
    expect(other).not.toBe(first)
    expect(dirname(other)).toBe(dirname(first))

    // Written *once*, not rewritten with the same bytes: the path is content-addressed, so a second
    // application of the same prompt must not truncate a file a `codex` process spawned by another
    // thread may be reading right now. A marker written over the file survives, which nothing but
    // leaving the file alone can do -- comparing the two paths would pass either way.
    writeFileSync(first, 'MARKER', 'utf8')
    const again = writeBaseInstructions('You are a release bot.')
    expect(again).toBe(first)
    expect(readFileSync(first, 'utf8')).toBe('MARKER')

    removeBaseInstructions()
    expect(existsSync(first)).toBe(false)
  })

  // Root ignores the directory mode this test relies on, so a suite run as root -- which a
  // container often is -- would see the write succeed and the assertion fail. The behaviour under
  // test is unprivileged behaviour; skipping is honest, and CI runs unprivileged.
  it.skipIf(process.getuid?.() === 0)('fails loudly when the prompt cannot be written at all', () => {
    const path = writeBaseInstructions('You are a release bot.')
    const directory = dirname(path)
    // Not an already-written file this time but a directory nothing may write to, which is the
    // difference between "Codex already has this prompt" and "Codex will not be given this prompt".
    chmodSync(directory, 0o500)
    try {
      expect(() => writeBaseInstructions('You are a changelog bot.')).toThrow(/EACCES/u)
    } finally {
      chmodSync(directory, 0o700)
      removeBaseInstructions()
    }
  })
})

describe('the model string', () => {
  it('comes apart at the first colon and goes back together the same way', () => {
    expect(splitModel('openai:gpt-5.6-sol')).toEqual({ provider: 'openai', model: 'gpt-5.6-sol' })
    expect(splitModel('openrouter:openai/gpt-5:beta')).toEqual({
      provider: 'openrouter',
      model: 'openai/gpt-5:beta',
    })
    expect(joinModel({ model: 'gpt-5.6-sol', provider: undefined })).toBe('gpt-5.6-sol')
    expect(joinModel({ model: 'qwen3', provider: 'ollama' })).toBe('ollama:qwen3')
  })

  it('is a bare slug when a colon has nothing on one side of it', () => {
    // Neither is a provider-qualified model, whatever it was meant to be, and resolving a provider
    // id of `''` would silently point the run at nothing.
    expect(splitModel('gpt-5.6-sol')).toEqual({ provider: undefined, model: 'gpt-5.6-sol' })
    expect(splitModel('openai:')).toEqual({ provider: undefined, model: 'openai:' })
    expect(splitModel(':gpt-5.6-sol')).toEqual({ provider: undefined, model: ':gpt-5.6-sol' })
  })

  it('names no provider the code does not pin', () => {
    const name = uniqueName()
    useLocalVariables(publishedValue(`agent__${name}`, {}))
    const agent = agentControl({
      name,
      // A `-c model_provider=...` that is not a string is not a provider id, so the code pins none.
      // Codex resolves the slug against a `config.toml` this package cannot read, and inventing
      // `openai` would both describe an identity the run need not have and, echoed back by an
      // editor, change the provider it was only meant to describe.
      codex: { config: { model_provider: 42 } },
      thread: { model: 'gpt-5.5' },
      publishBaseline: false,
    })
    expect(agent.baseline().model).toBe('gpt-5.5')
  })
})
