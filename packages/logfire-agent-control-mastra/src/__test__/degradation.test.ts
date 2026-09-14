import { Agent } from '@mastra/core/agent'
import type { InputProcessor, ProcessInputArgs, ProcessInputStepArgs } from '@mastra/core/processors'
import { configureVariables, getVariableProvider } from '@pydantic/logfire-node/vars'
import type { SerializedResolvedVariable } from '@pydantic/logfire-node/vars'
import { describe, expect, it } from 'vite-plus/test'

import { agentControl } from '../index'
import {
  callAt,
  captureWarnings,
  mockModel,
  nextAgentId,
  publishedValue,
  run,
  systemPrompt,
  useLocalVariables,
  useManagedAgent,
  useNoVariables,
} from './helpers'

const warnings = captureWarnings()

/** A provider that fails every read, the way an unreachable Logfire API does. */
function useBrokenProvider(): void {
  configureVariables(false)
  const provider = getVariableProvider() as { getSerializedValue: () => Promise<SerializedResolvedVariable> }
  provider.getSerializedValue = async () => Promise.reject(new Error('connection refused'))
}

/** A promise and the call that settles it, for holding one request open while another runs. */
function deferred(): { settled: Promise<void>; settle: () => void } {
  let settle!: () => void
  const settled = new Promise<void>((resolve) => {
    settle = resolve
  })
  return { settled, settle }
}

function agentWith(id: string, model = mockModel(), options = {}): Agent {
  return new Agent({ id, name: 'A', instructions: 'Code text.', model, inputProcessors: [agentControl(options)] })
}

describe('when Logfire has nothing to say', () => {
  it('runs the agent as written when variables are switched off', async () => {
    const id = nextAgentId()
    useNoVariables()
    const model = mockModel()

    expect(await run(agentWith(id, model))).toBe('ok')
    expect(systemPrompt(model)).toEqual(['Code text.'])
    expect(warnings.messages).toEqual([])
  })

  it('runs the agent as written when nothing is published for it', async () => {
    const id = nextAgentId()
    useLocalVariables()
    const model = mockModel()

    expect(await run(agentWith(id, model))).toBe('ok')
    expect(systemPrompt(model)).toEqual(['Code text.'])
    expect(warnings.messages).toEqual([])
  })

  it('runs the agent as written, saying so once, when Logfire cannot be reached', async () => {
    const id = nextAgentId()
    useBrokenProvider()
    const model = mockModel()

    expect(await run(agentWith(id, model))).toBe('ok')
    expect(systemPrompt(model)).toEqual(['Code text.'])
    expect(warnings.messages).toEqual([expect.stringContaining(`Logfire managed variable 'agent__${id}' could not be resolved`)])
  })

  it('applies the sections of a published value it can read, and warns about the one it cannot', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { instructions: 42, settings: { temperature: 0.4 } })
    const model = mockModel()

    await run(agentWith(id, model))

    expect(systemPrompt(model)).toEqual(['Code text.'])
    expect(warnings.messages).toEqual([expect.stringContaining('Managed instructions section has invalid container')])
  })
})

/** The hook arguments a processor-only context supplies, which is everything but the agent. */
function inputArgs(state: Record<string, unknown>): ProcessInputArgs {
  return { state, messageList: { get: {} }, systemMessages: [] } as unknown as ProcessInputArgs
}

function stepArgs(state: Record<string, unknown>): ProcessInputStepArgs {
  return {
    state,
    systemMessages: [],
    messageList: { getSystemMessages: () => [] },
    modelSettings: {},
  } as unknown as ProcessInputStepArgs
}

/**
 * A stand-in for the `Agent` a processor-only context has no real one of.
 *
 * Mastra's types require an `id` and its runtime falls over without one long before a processor is
 * reached, so an agent with no name is only reachable by hand. The guard is still worth having: a
 * JavaScript caller can leave both `id` and `name` out, and an unnamed agent would otherwise share
 * one variable with every other unnamed agent.
 */
function unnamedAgentArgs(id: unknown): ProcessInputArgs {
  return {
    state: {},
    agent: { id, __getOverridableFields: () => ({ instructions: 'x' }), getDefaultOptions: () => ({}) },
  } as unknown as ProcessInputArgs
}

describe('when the processor is not on an agent', () => {
  it('changes nothing, and says why, when there is no agent to read', async () => {
    const processor: InputProcessor = agentControl()
    const state: Record<string, unknown> = {}

    await processor.processInput?.(inputArgs(state))
    const result = await processor.processInputStep?.(stepArgs(state))

    expect(result).toBeUndefined()
    expect(warnings.messages).toEqual([expect.stringContaining('ran without an agent')])
  })

  it('changes nothing, and says why, when the per-request hook never ran', async () => {
    const processor: InputProcessor = agentControl()

    const result = await processor.processInputStep?.(stepArgs({}))

    expect(result).toBeUndefined()
    expect(warnings.messages).toEqual([expect.stringContaining('ran without the per-request state')])
  })
})

describe('two runs that overlap', () => {
  it("keeps each one on its own agent's config", async () => {
    const first = nextAgentId()
    const second = nextAgentId()
    useLocalVariables({
      variables: {
        ...publishedValue(`agent__${first}`, { settings: { temperature: 0.9 } }).variables,
        ...publishedValue(`agent__${second}`, { settings: { temperature: 0.1 } }).variables,
      },
    })

    // One processor instance on both agents, and the first request held open at the model call until
    // the second has been through the whole of its own. Anything this adapter kept per instance
    // rather than per request would have been overwritten by the time the first call is let go.
    const held = deferred()
    const processor = agentControl()
    const firstModel = mockModel()
    const inner = firstModel.doGenerate.bind(firstModel)
    firstModel.doGenerate = async (options) => {
      await held.settled
      return inner(options)
    }
    const secondModel = mockModel()
    const agentOf = (id: string, model: ReturnType<typeof mockModel>): Agent =>
      new Agent({ id, name: 'A', instructions: 'Code text.', model, inputProcessors: [processor] })

    const running = run(agentOf(first, firstModel))
    await run(agentOf(second, secondModel))
    held.settle()
    await running

    expect(callAt(firstModel, 0)).toMatchObject({ temperature: 0.9 })
    expect(callAt(secondModel, 0)).toMatchObject({ temperature: 0.1 })
  })
})

describe('naming the agent', () => {
  it('reads the variable the agent id names', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { instructions: [{ id: 'agent', instructions: 'Managed.' }] })
    const model = mockModel()

    await run(agentWith(id, model))

    expect(systemPrompt(model)).toEqual(['Managed.'])
  })

  it('reads the same variable on every request the agent serves', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { instructions: [{ id: 'agent', instructions: 'Managed.' }] })
    const model = mockModel()
    const agent = agentWith(id, model)

    await run(agent)
    await run(agent)

    // The control is built once per agent and reused, so a long-lived agent does not re-register its
    // variable, re-warm the SDK's cache, or re-attempt the baseline publish on every request.
    expect(systemPrompt(model, 0)).toEqual(['Managed.'])
    expect(systemPrompt(model, 1)).toEqual(['Managed.'])
  })

  it('takes a name of its own, for an agent whose id is not the one to key on', async () => {
    const id = nextAgentId()
    const managedName = nextAgentId()
    useLocalVariables(publishedValue(`agent__${managedName}`, { instructions: [{ id: 'agent', instructions: 'Managed.' }] }))
    const model = mockModel()

    await run(agentWith(id, model, { name: managedName }))

    expect(systemPrompt(model)).toEqual(['Managed.'])
  })

  it('refuses to run an agent it cannot name', async () => {
    useLocalVariables()
    const processor = agentControl()

    await expect(processor.processInput?.(unnamedAgentArgs(undefined))).rejects.toThrow(/needs a name for this agent/u)
    await expect(processor.processInput?.(unnamedAgentArgs('  '))).rejects.toThrow(/needs a name for this agent/u)
  })
})
