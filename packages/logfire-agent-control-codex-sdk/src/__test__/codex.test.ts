/**
 * The end of the pipe: a published config, through the real Codex SDK, to the flags a `codex`
 * process is actually started with.
 *
 * Every other test here asserts on the options object this package returns. This one asserts on the
 * argv of a child process, because the options object is only a claim about what the SDK will do
 * with it -- `config` becomes dotted `--config` flags, `model` becomes `--model`, and
 * `modelReasoningEffort` becomes a `--config` flag rather than a flag of its own. The stand-in
 * binary never talks to a model; it records what it was given and prints a finished turn.
 */

import { describe, expect, it } from 'vite-plus/test'

import { agentControl } from '../index'
import { argvCapture, captureWarnings, configOverrides, FAKE_CODEX, flag, publishedValue, uniqueName, useLocalVariables } from './helpers'

captureWarnings()

/** Run one turn against the fake binary and hand back the argv it saw. */
async function runFake(managed: { startThread: () => Promise<{ run: (input: string) => Promise<{ finalResponse: string }> }> }) {
  const capture = argvCapture()
  process.env['FAKE_CODEX_ARGV'] = capture.path
  const thread = await managed.startThread()
  const turn = await thread.run('hello')
  expect(turn.finalResponse).toBe('ok')
  return capture.read()
}

describe('a managed Codex run', () => {
  it('starts the binary with the published instructions, model, and reasoning effort', async () => {
    const name = uniqueName()
    useLocalVariables(
      publishedValue(`agent__${name}`, {
        instructions: [{ id: 'developer_instructions', instructions: 'Escalate anything over $500 to a human.' }, 'Never force-push.'],
        model: 'openai:gpt-5.6-sol',
        settings: { thinking: 'high' },
      })
    )
    const managed = agentControl({
      name,
      codex: {
        codexPathOverride: FAKE_CODEX,
        config: { developer_instructions: 'Be terse.', sandbox_mode: 'read-only' },
      },
      thread: { model: 'gpt-5.5', modelReasoningEffort: 'low', skipGitRepoCheck: true },
    })

    const argv = await runFake(managed)

    expect(argv[0]).toBe('exec')
    expect(configOverrides(argv)).toEqual({
      // The added block is joined onto the developer message, after the block it follows.
      developer_instructions: '"Escalate anything over $500 to a human.\\n\\nNever force-push."',
      // Untouched keys survive: this adapter patches a copy of the caller's config.
      sandbox_mode: '"read-only"',
      model_provider: '"openai"',
      model_reasoning_effort: '"high"',
    })
    expect(flag(argv, '--model')).toBe('gpt-5.6-sol')
  })

  it('leaves the binary running on code when nothing is published', async () => {
    const managed = agentControl({
      name: uniqueName(),
      codex: { codexPathOverride: FAKE_CODEX, config: { developer_instructions: 'Be terse.' } },
      thread: { model: 'gpt-5.5', skipGitRepoCheck: true },
    })

    const argv = await runFake(managed)

    expect(configOverrides(argv)).toEqual({ developer_instructions: '"Be terse."' })
    expect(flag(argv, '--model')).toBe('gpt-5.5')
  })

  it('runs a whole thread inside the resolution the config came from', async () => {
    const name = uniqueName()
    useLocalVariables(publishedValue(`agent__${name}`, { instructions: 'Only touch the changelog.' }))
    const managed = agentControl({
      name,
      codex: { codexPathOverride: FAKE_CODEX },
      thread: { skipGitRepoCheck: true },
    })
    const capture = argvCapture()
    process.env['FAKE_CODEX_ARGV'] = capture.path

    const answer = await managed.run(async (thread) => (await thread.run('go')).finalResponse)

    expect(answer).toBe('ok')
    expect(configOverrides(capture.read())).toEqual({ developer_instructions: '"Only touch the changelog."' })
  })

  it('resumes a thread with the published config re-sent as flags', async () => {
    const name = uniqueName()
    useLocalVariables(publishedValue(`agent__${name}`, { settings: { thinking: 'minimal' } }))
    const managed = agentControl({
      name,
      codex: { codexPathOverride: FAKE_CODEX },
      thread: { skipGitRepoCheck: true },
    })
    const capture = argvCapture()
    process.env['FAKE_CODEX_ARGV'] = capture.path

    const thread = await managed.resumeThread('t_earlier')
    await thread.run('and now the changelog')

    const argv = capture.read()
    expect(argv[0]).toBe('exec')
    expect(flag(argv, 'resume')).toBe('t_earlier')
    expect(configOverrides(argv)['model_reasoning_effort']).toBe('"minimal"')
  })

  it('clears a removed developer block on the command line rather than dropping the flag', async () => {
    const name = uniqueName()
    useLocalVariables(publishedValue(`agent__${name}`, { instructions: [{ id: 'developer_instructions', instructions: null }] }))
    const managed = agentControl({
      name,
      codex: { codexPathOverride: FAKE_CODEX, config: { developer_instructions: 'Be terse.' } },
      thread: { skipGitRepoCheck: true },
    })

    const argv = await runFake(managed)

    // `developer_instructions=""` is on the command line, because a missing flag is not a removal:
    // it is Codex falling back to the `developer_instructions` in the user's own `config.toml`.
    expect(configOverrides(argv)).toEqual({ developer_instructions: '""' })
  })

  it('points the binary at a file holding a published base prompt', async () => {
    const name = uniqueName()
    useLocalVariables(
      publishedValue(`agent__${name}`, {
        instructions: [{ id: 'base_instructions', instructions: 'You are a release bot. Only edit CHANGELOG.md.' }],
      })
    )
    const managed = agentControl({
      name,
      codex: { codexPathOverride: FAKE_CODEX },
      thread: { skipGitRepoCheck: true },
    })

    const argv = await runFake(managed)

    const file = configOverrides(argv)['model_instructions_file']
    expect(file).toMatch(/^".*\.md"$/u)
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(JSON.parse(file as string) as string, 'utf8')).toBe('You are a release bot. Only edit CHANGELOG.md.')
  })
})
