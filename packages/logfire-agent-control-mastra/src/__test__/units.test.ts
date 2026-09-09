/**
 * The mappings, at the level of one value in and one value out.
 *
 * Everything here is also exercised through a real Mastra run in the other files; these are the
 * shapes a run cannot easily produce -- a tool that reached the step unbuilt, a system message
 * carrying something other than text, a provider with nowhere to put a setting.
 */

import type { InputProcessor, ProcessInputArgs, ProcessInputStepArgs } from '@mastra/core/processors'
import { describe, expect, it } from 'vite-plus/test'

import { agentControl } from '../index'
import { baselineBlocks, readCodeInstructions, requestBlocks, toSystemMessages } from '../instructions'
import { honorsReasoning, providerOf } from '../model'
import { lowerSettings } from '../settings'
import { applyToTools, readTools } from '../tools'
import { captureWarnings, nextAgentId, useManagedAgent } from './helpers'

const warnings = captureWarnings()

const NO_TAGS = { getSystemMessages: () => [] }

describe("reading the agent's instructions", () => {
  it('reads every shape Mastra accepts, and refuses the ones it cannot address', () => {
    expect(readCodeInstructions('One.')).toEqual({ blocks: [{ id: 'agent', text: 'One.' }] })
    expect(readCodeInstructions(['One.', 'Two.'])).toEqual({
      blocks: [
        { id: 'agent:0', text: 'One.' },
        { id: 'agent:1', text: 'Two.' },
      ],
    })
    // A single system message object is one block, like the string it wraps.
    expect(readCodeInstructions({ role: 'system', content: 'One.' })).toEqual({
      blocks: [{ id: 'agent', text: 'One.' }],
    })
    expect(readCodeInstructions([{ role: 'system', content: 'One.' }])).toEqual({
      blocks: [{ id: 'agent:0', text: 'One.' }],
    })
    // Computed per request, so there is no code-side text to point an id at.
    expect(readCodeInstructions(() => 'One.')).toBeNull()
    // Neither is anything this cannot read as text -- and one unreadable entry disqualifies the whole
    // list, because ids after it would name blocks that are not the ones they say.
    expect(readCodeInstructions(['One.', { role: 'system', content: [{ type: 'text', text: 'Two.' }] }])).toBeNull()
    expect(readCodeInstructions(42)).toBeNull()
    expect(readCodeInstructions(undefined)).toBeNull()
  })

  it('takes the id an entry declares for itself, in either dialect, over its position', () => {
    expect(
      readCodeInstructions([
        { role: 'system', content: 'One.', providerOptions: { logfire: { id: 'persona' } } },
        // Mastra's `SystemMessage` is the union of the AI SDK's v4 and v5 message shapes, and this is
        // what v4 calls the same field.
        { role: 'system', content: 'Two.', experimental_providerMetadata: { logfire: { id: 'policy' } } },
        // Everything a declaration could be but is not: another provider's namespace, a namespace
        // without an id, an id that is not a string, and one that is empty.
        { role: 'system', content: 'Three.', providerOptions: { openai: { id: 'theirs' } } },
        { role: 'system', content: 'Four.', providerOptions: { logfire: 'no' } },
        { role: 'system', content: 'Five.', providerOptions: { logfire: { id: 5 } } },
        { role: 'system', content: 'Six.', providerOptions: { logfire: { id: '' } } },
      ])
    ).toEqual({
      blocks: [
        { id: 'persona', text: 'One.' },
        { id: 'policy', text: 'Two.' },
        { id: 'agent:2', text: 'Three.' },
        { id: 'agent:3', text: 'Four.' },
        { id: 'agent:4', text: 'Five.' },
        { id: 'agent:5', text: 'Six.' },
      ],
    })
  })
})

describe('the blocks a request assembles', () => {
  const systemMessages = [
    { role: 'system' as const, content: 'Agent.' },
    { role: 'system' as const, content: 'Added by a skill.' },
  ]

  it("names the agent's own blocks and marks everything else as the framework's", () => {
    const blocks = requestBlocks(
      systemMessages,
      { blocks: [{ id: 'agent', text: 'Agent.' }] },
      {
        getSystemMessages: (tag?: string) => (tag === 'memory' ? [{ role: 'system' as const, content: 'Recalled.' }] : []),
      }
    )

    expect(blocks).toEqual([
      { id: 'agent', text: 'Agent.', dynamic: false, message: systemMessages[0] },
      { id: null, text: 'Added by a skill.', dynamic: true, message: systemMessages[1] },
      { id: 'tag:memory', text: 'Recalled.', dynamic: true },
    ])
  })

  it('gives computed instructions one seam and no addressable text', () => {
    expect(requestBlocks(systemMessages, null, NO_TAGS)).toEqual([
      { id: 'agent', text: 'Agent.', dynamic: true, message: systemMessages[0] },
      { id: null, text: 'Added by a skill.', dynamic: true, message: systemMessages[1] },
    ])
  })

  it('returns an untouched block as the very message it was read from', () => {
    const message = { role: 'system' as const, content: 'Agent.', providerOptions: { logfire: { keep: true } } }
    const blocks = requestBlocks([message], { blocks: [{ id: 'agent', text: 'Agent.' }] }, NO_TAGS)

    // Identity, not equality: everything else riding on the message survives a request this adapter
    // did not change.
    expect(toSystemMessages(blocks)[0]).toBe(message)
    expect(toSystemMessages([{ id: 'agent', text: 'Rewritten.', dynamic: false }])).toEqual([{ role: 'system', content: 'Rewritten.' }])
  })

  it("describes the code, and carries the framework's seams through, in the baseline", () => {
    const blocks = requestBlocks(systemMessages, { blocks: [{ id: 'agent:0', text: 'Agent.' }] }, NO_TAGS)

    expect(baselineBlocks(blocks, { blocks: [{ id: 'agent:0', text: 'Agent.' }] })).toEqual([
      { id: 'agent:0', text: 'Agent.', dynamic: false },
      { id: null, text: 'Added by a skill.', dynamic: true, message: systemMessages[1] },
    ])
    // With nothing knowable in code, the baseline is exactly what the request showed.
    expect(baselineBlocks(blocks, null)).toEqual(blocks)
  })
})

describe('reading a model', () => {
  it('names the provider serving a step, whatever form the model is in', () => {
    expect(providerOf('openai/gpt-5.6-sol')).toBe('openai')
    expect(providerOf({ provider: 'anthropic.messages' })).toBe('anthropic')
    expect(providerOf('gpt-5.6-sol')).toBeUndefined()
    expect(providerOf({ modelId: 'x' })).toBeUndefined()
    expect(providerOf(undefined)).toBeUndefined()
  })

  it('knows which models act on a reasoning level', () => {
    expect(honorsReasoning({ specificationVersion: 'v4' })).toBe(true)
    expect(honorsReasoning({ specificationVersion: 'v3' })).toBe(false)
    // A router id is resolved after the hook, so it cannot be asked and gets the benefit of the doubt.
    expect(honorsReasoning('openai/gpt-5.6-sol')).toBe(true)
    expect(honorsReasoning({})).toBe(true)
  })
})

describe('lowering settings', () => {
  const NO_SETTINGS = {
    modelSettings: { effective: undefined, defaults: undefined },
    providerOptions: { effective: undefined, defaults: undefined },
  }

  it('has nowhere to put `parallel_tool_calls` when the step names no provider', () => {
    expect(lowerSettings({ parallel_tool_calls: true }, { provider: undefined, supportsReasoning: true, ...NO_SETTINGS })).toEqual({
      modelSettings: undefined,
      providerOptions: undefined,
      unapplied: ['parallel_tool_calls'],
    })
  })

  it('leaves the step alone when the published value is the one it already has', () => {
    // Not the same as publishing nothing: the section is there and it was applied, it just asks for
    // what the code already says, and returning an equal object would have Mastra rebuild the step
    // for nothing.
    expect(
      lowerSettings(
        { temperature: 0.2, parallel_tool_calls: true },
        {
          provider: 'openai',
          supportsReasoning: true,
          modelSettings: { effective: { temperature: 0.2 }, defaults: { temperature: 0.2 } },
          providerOptions: {
            effective: { openai: { parallelToolCalls: true } },
            defaults: { openai: { parallelToolCalls: true } },
          },
        }
      )
    ).toEqual({ modelSettings: undefined, providerOptions: undefined, unapplied: [] })
  })
})

describe('reading and patching tools', () => {
  const jsonSchema = { type: 'object', properties: { city: { type: 'string', description: 'City name' } } }

  it('reads a built tool, an unbuilt one, and one whose schema it cannot read', () => {
    expect(
      readTools({
        built: { description: 'Built.', parameters: { jsonSchema, validate: () => true } },
        unbuilt: { description: 'Unbuilt.', inputSchema: jsonSchema },
        // A Standard Schema (a Zod schema, say) is not a JSON schema, and turning one into a JSON
        // schema means knowing which library wrote it.
        opaque: { inputSchema: { '~standard': { version: 1 } } },
      })
    ).toEqual({
      definitions: [
        { name: 'built', description: 'Built.', parametersJsonSchema: jsonSchema },
        { name: 'unbuilt', description: 'Unbuilt.', parametersJsonSchema: jsonSchema },
        { name: 'opaque', parametersJsonSchema: {} },
      ],
      reserved: [],
    })
  })

  it('leaves a provider-defined tool out of the editable set and holds its name against a rename', () => {
    expect(
      readTools({
        // Mastra sends `tool.name ?? recordKey`, so the wire name is the tool's own where it has one.
        search: { type: 'provider-defined', id: 'openai.web_search', name: 'web_search', args: {} },
        keyed: { type: 'provider-defined', id: 'openai.code_interpreter', args: {} },
      })
    ).toEqual({ definitions: [], reserved: ['web_search', 'keyed'] })
  })

  it("patches an unbuilt tool's schema where it keeps it", () => {
    const tools = { unbuilt: { description: 'Unbuilt.', inputSchema: jsonSchema } }
    const patched = { type: 'object', properties: { city: { type: 'string', description: 'Patched.' } } }

    expect(
      applyToTools(tools, readTools(tools).definitions, [{ name: 'unbuilt', description: 'Patched.', parametersJsonSchema: patched }])
    ).toEqual({ unbuilt: { description: 'Patched.', inputSchema: patched } })
  })

  it('rewrites a parameter description without touching the tool description', () => {
    const tools = { built: { description: 'Built.', parameters: { jsonSchema } } }
    const patched = { type: 'object', properties: { city: { type: 'string', description: 'Patched.' } } }

    expect(applyToTools(tools, readTools(tools).definitions, [{ name: 'built', parametersJsonSchema: patched }])).toEqual({
      built: { description: 'Built.', parameters: { jsonSchema: patched } },
    })
  })

  it('hands back the record it was given when no override changed anything', () => {
    const tools = { built: { description: 'Built.', parameters: { jsonSchema } } }

    // Identity: the caller uses it to leave the step's tools alone, so Mastra does not re-prepare a
    // tool set that is the one it already had.
    const { definitions } = readTools(tools)
    expect(applyToTools(tools, definitions, definitions)).toBe(tools)
  })

  it('rewrites a tool description without touching its schema', () => {
    const tools = { built: { description: 'Built.', parameters: { jsonSchema } } }

    expect(
      applyToTools(tools, readTools(tools).definitions, [{ name: 'built', description: 'Patched.', parametersJsonSchema: jsonSchema }])
    ).toEqual({ built: { description: 'Patched.', parameters: { jsonSchema } } })
  })

  it('leaves a tool alone when the applied definitions run out before it', () => {
    const tools = { built: { description: 'Built.', parameters: { jsonSchema } } }

    // Not a result the core returns -- it hands back one definition per definition it was given --
    // and the point of the guard is that a short list is never read as an offset one.
    expect(applyToTools(tools, readTools(tools).definitions, [])).toBe(tools)
  })
})

describe('a step with nothing on it', () => {
  /** Drive the two hooks by hand, for the arguments a real agent run never produces. */
  async function driveStep(agentId: string, step: Partial<ProcessInputStepArgs>): Promise<unknown> {
    const processor: InputProcessor = agentControl({ label: 'production' })
    const state: Record<string, unknown> = {}
    await processor.processInput?.({
      state,
      agent: {
        id: agentId,
        __getOverridableFields: () => ({ instructions: 'Code text.', model: 'openai/gpt-5.6-sol' }),
        getDefaultOptions: () => ({}),
      },
    } as unknown as ProcessInputArgs)
    return processor.processInputStep?.({
      state,
      systemMessages: [{ role: 'system', content: 'Code text.' }],
      messageList: NO_TAGS,
      ...step,
    } as unknown as ProcessInputStepArgs)
  }

  it('reports a tool override when the step advertises no tools at all', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { tool_definitions: [{ name: 'getWeather', description: 'Nowhere.' }] })

    // No `tools` key at all, which is what Mastra passes an agent that has none, and a shape only a
    // hand-built step can produce here.
    expect(await driveStep(id, {})).toEqual({})
    expect(warnings.messages).toEqual([expect.stringContaining("patches tool 'getWeather', which no toolset advertises for this request")])
  })

  it('notes which published value drove the request, on its own span', async () => {
    const id = nextAgentId()
    useManagedAgent(id, { model: 'openai:gpt-5.6-sol' })
    const updates: unknown[] = []
    const processor: InputProcessor = agentControl({ label: 'production' })

    await processor.processInput?.({
      state: {},
      agent: { id, __getOverridableFields: () => ({ instructions: 'x' }), getDefaultOptions: () => ({}) },
      tracingContext: { currentSpan: { update: (options: unknown) => updates.push(options) } },
    } as unknown as ProcessInputArgs)

    // The core's `run()` would put this on every span of the run as baggage, but a processor is a
    // callback rather than a scope to wrap; the processor's own span is where this adapter can say it.
    expect(updates).toEqual([
      {
        metadata: {
          'logfire.agent_control': {
            variable: `agent__${id}`,
            label: 'production',
            version: 1,
            reason: 'resolved',
          },
        },
      },
    ])
  })

  it('says the same thing once, however many requests hit it', async () => {
    const processor: InputProcessor = agentControl()
    const args = { state: {} } as unknown as ProcessInputArgs

    await processor.processInput?.(args)
    await processor.processInput?.(args)

    // The config is resolved on every request, so a report that repeated per request would bury
    // itself. The core deduplicates its own warnings the same way.
    expect(warnings.messages).toEqual([expect.stringContaining('ran without an agent')])
  })
})
