import { generateText, ToolLoopAgent } from 'ai'
import { describe, expect, it } from 'vitest'

import { agentControl, UnmatchedConfigError } from '../index'
import { captureWarnings, publishedValue, stubModel, textResult, useLocalVariables, useNoVariables } from './helpers'

const warnings = captureWarnings()

/** The system messages of the request the model was made with. */
function systemMessages(model: { doGenerateCalls: { prompt: unknown[] }[] }, call = 0): unknown[] {
  return (model.doGenerateCalls[call]?.prompt ?? []).filter((message) => (message as { role: string }).role === 'system')
}

describe('instructions', () => {
  it('rewrites the block an id addresses and leaves its neighbours alone', async () => {
    useLocalVariables(
      publishedValue('agent__three_blocks', {
        instructions: [{ id: 'system:1', instructions: 'Confirm the order total in writing.' }],
      })
    )
    const model = stubModel([textResult('ok')])
    await generateText({
      model: agentControl({ model, name: 'three_blocks', label: 'production' }),
      instructions: [
        { role: 'system', content: 'You are a concise checkout assistant.' },
        { role: 'system', content: 'Always confirm the order total.' },
        { role: 'system', content: 'Escalate anything over $500.' },
      ],
      prompt: 'hi',
    })

    expect(systemMessages(model)).toEqual([
      { role: 'system', content: 'You are a concise checkout assistant.' },
      { role: 'system', content: 'Confirm the order total in writing.' },
      { role: 'system', content: 'Escalate anything over $500.' },
    ])
  })

  it('addresses a block by the id its `providerOptions` declares, and keeps those options', async () => {
    useLocalVariables(publishedValue('agent__keyed_blocks', { instructions: [{ id: 'refunds', instructions: 'Refund on request.' }] }))
    const model = stubModel([textResult('ok')])
    await generateText({
      model: agentControl({ model, name: 'keyed_blocks', label: 'production' }),
      instructions: [
        {
          role: 'system',
          content: 'You are a refund specialist.',
          providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
        },
        {
          role: 'system',
          content: 'Always confirm the order total.',
          providerOptions: { logfire: { id: 'refunds' } },
        },
      ],
      prompt: 'hi',
    })

    // The declared id survives, the block keeps its position, and the cache breakpoint on the block
    // ahead of it is exactly where the user put it.
    expect(systemMessages(model)).toEqual([
      {
        role: 'system',
        content: 'You are a refund specialist.',
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      },
      { role: 'system', content: 'Refund on request.', providerOptions: { logfire: { id: 'refunds' } } },
    ])
  })

  it('drops a block whose override publishes no text', async () => {
    useLocalVariables(publishedValue('agent__dropped_block', { instructions: [{ id: 'system:0' }] }))
    const model = stubModel([textResult('ok')])
    await generateText({
      model: agentControl({ model, name: 'dropped_block', label: 'production' }),
      instructions: [
        { role: 'system', content: 'Drop me.' },
        { role: 'system', content: 'Keep me.' },
      ],
      prompt: 'hi',
    })

    expect(systemMessages(model)).toEqual([{ role: 'system', content: 'Keep me.' }])
  })

  it('adds a block at the end of the static group, ahead of a dynamic one', async () => {
    useLocalVariables(publishedValue('agent__added_block', { instructions: 'Escalate anything over $500 to a human.' }))
    const model = stubModel([textResult('one'), textResult('two')])
    const agent = new ToolLoopAgent(
      agentControl({
        settings: {
          id: 'added_block',
          model,
          instructions: 'You are a concise assistant.',
          prepareStep: () => ({
            instructions: [
              { role: 'system' as const, content: 'You are a concise assistant.' },
              { role: 'system' as const, content: 'Tenant: acme.' },
            ],
          }),
        },
        label: 'production',
      })
    )
    await agent.generate({ prompt: 'hi' })

    expect(systemMessages(model)).toEqual([
      { role: 'system', content: 'You are a concise assistant.' },
      { role: 'system', content: 'Escalate anything over $500 to a human.' },
      { role: 'system', content: 'Tenant: acme.' },
    ])
  })

  it('adds a block to a request that carries no instructions at all', async () => {
    useLocalVariables(publishedValue('agent__no_instructions', { instructions: 'Be brief.' }))
    const model = stubModel([textResult('ok')])
    await generateText({
      model: agentControl({ model, name: 'no_instructions', label: 'production' }),
      prompt: 'hi',
    })

    expect(model.doGenerateCalls[0]?.prompt[0]).toEqual({ role: 'system', content: 'Be brief.' })
  })

  it('refuses to address a block a per-request hook injected, and says why', async () => {
    useLocalVariables(publishedValue('agent__dynamic_block', { instructions: [{ id: 'system:1', instructions: 'Tenant: pinned.' }] }))
    let tenant = 'acme'
    const model = stubModel([textResult('one'), textResult('two')])
    const agent = new ToolLoopAgent(
      agentControl({
        settings: {
          id: 'dynamic_block',
          model,
          instructions: 'You are a concise assistant.',
          prepareStep: () => ({
            instructions: [
              { role: 'system' as const, content: 'You are a concise assistant.' },
              { role: 'system' as const, content: `Tenant: ${tenant}.` },
            ],
          }),
        },
        label: 'production',
      })
    )
    await agent.generate({ prompt: 'hi' })
    tenant = 'globex'
    await agent.generate({ prompt: 'hi again' })

    expect(systemMessages(model, 1)).toEqual([
      { role: 'system', content: 'You are a concise assistant.' },
      { role: 'system', content: 'Tenant: globex.' },
    ])
    expect(warnings.messages).toContainEqual(expect.stringContaining('recomputes'))
  })

  it('keeps both messages when two of them declare the same id', async () => {
    useLocalVariables(publishedValue('agent__duplicate_ids', { instructions: [{ id: 'policy', instructions: 'One policy.' }] }))
    const model = stubModel([textResult('ok')])
    const block = (content: string) => ({
      role: 'system' as const,
      content,
      providerOptions: { logfire: { id: 'policy' } },
    })
    await generateText({
      model: agentControl({ model, name: 'duplicate_ids', label: 'production' }),
      instructions: [block('Refund on request.'), block('Escalate anything over $500.')],
      prompt: 'hi',
    })

    // Both messages carry one id, so the override addresses both -- and, above all, neither message
    // is dropped from the prompt on the way back into it.
    expect(systemMessages(model)).toEqual([block('One policy.'), block('One policy.')])
  })

  it('protects an injected block from the first request when the agent declares no instructions at all', async () => {
    useLocalVariables(publishedValue('agent__empty_declaration', { instructions: [{ id: 'system:0', instructions: 'Tenant: pinned.' }] }))
    const model = stubModel([textResult('ok')])
    const agent = new ToolLoopAgent(
      agentControl({
        settings: {
          id: 'empty_declaration',
          model,
          // Declared, and empty: every system message this agent sends comes from its hook.
          instructions: [],
          prepareStep: () => ({ instructions: [{ role: 'system' as const, content: 'Tenant: acme.' }] }),
        },
        label: 'production',
      })
    )
    await agent.generate({ prompt: 'hi' })

    // An empty declaration is a declaration. Reading it as "nothing was declared" would leave the
    // first request with nothing to compare against and pin one tenant's text.
    expect(systemMessages(model)).toEqual([{ role: 'system', content: 'Tenant: acme.' }])
    expect(warnings.messages).toContainEqual(expect.stringContaining('recomputes'))
  })

  it('learns the code-side text from the first request when nothing was declared', async () => {
    useLocalVariables(publishedValue('agent__learned', { instructions: [{ id: 'system:0', instructions: 'Managed.' }] }))
    const model = stubModel([textResult('one'), textResult('two')])
    const managed = agentControl({ model, name: 'learned', label: 'production' })
    await generateText({ model: managed, instructions: 'Code text.', prompt: 'hi' })
    // A second request whose block matches what the first carried is still static, so still managed.
    await generateText({ model: managed, instructions: 'Code text.', prompt: 'hi' })

    expect(systemMessages(model, 1)).toEqual([{ role: 'system', content: 'Managed.' }])
  })

  it('reports an id no block carries, and fails the run when told to', async () => {
    useLocalVariables(publishedValue('agent__unmatched_id', { instructions: [{ id: 'nope', instructions: 'Unreachable.' }] }))
    const model = stubModel([textResult('ok'), textResult('ok')])
    await generateText({
      model: agentControl({ model, name: 'unmatched_id', label: 'production' }),
      instructions: 'Be brief.',
      prompt: 'hi',
    })
    expect(warnings.messages).toContainEqual(expect.stringContaining("instruction block 'nope'"))

    await expect(
      generateText({
        model: agentControl({ model, name: 'unmatched_id', label: 'production', onUnmatched: 'error' }),
        instructions: 'Be brief.',
        prompt: 'hi',
      })
    ).rejects.toBeInstanceOf(UnmatchedConfigError)
  })

  it('runs on code when Logfire is unavailable', async () => {
    useNoVariables()
    const model = stubModel([textResult('ok')])
    const { text } = await generateText({
      model: agentControl({ model, name: 'unavailable' }),
      instructions: 'Be brief.',
      prompt: 'hi',
    })

    expect(text).toBe('ok')
    expect(systemMessages(model)).toEqual([{ role: 'system', content: 'Be brief.' }])
  })
})
