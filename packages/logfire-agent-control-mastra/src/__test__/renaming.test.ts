/**
 * The model boundary, at the level of one call in and one call out.
 *
 * A rename is exercised end to end against a real Mastra agent in `tools.test.ts`; what is here is
 * the handful of calls a run cannot produce -- a request with no tools on it, a tool the core routed
 * nowhere -- and the pass-through that has to keep working for every part a rename does not touch.
 */

import type { AppliedTools, Resolution, ToolDef } from '@pydantic/logfire-node/agent-control'
import { describe, expect, it } from 'vite-plus/test'

import { renamingModel, toolRenames } from '../renaming'
import type { ResolvedModel, ToolRenames } from '../renaming'

/** Nothing published: the shape a resolution has when the agent is running on its code. */
const CODE_ONLY: Resolution = {
  config: null,
  variableName: 'agent__renaming',
  label: null,
  version: null,
  reason: 'code_default',
}

const RENAMES: ToolRenames = {
  toModel: new Map([['getWeather', 'lookup_weather']]),
  toCode: new Map([['lookup_weather', 'getWeather']]),
}

/** One call, in the shape both of a model's methods take and answer with. */
interface Call {
  tools?: { name: string }[]
  toolChoice?: { type: string; toolName?: string }
  prompt: { role: string; content: string | { type: string; toolName?: string }[] }[]
}

/** A stub in the shape Mastra's own model classes have: both call methods answer with a stream. */
function stubModel(chunks: { type: string; toolName?: string }[]): {
  model: ResolvedModel
  calls: Call[]
} {
  const calls: Call[] = []
  const answer = async (options: Call): Promise<unknown> => {
    calls.push(options)
    return Promise.resolve({
      warnings: [],
      stream: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk)
          }
          controller.close()
        },
      }),
    })
  }
  const model = { specificationVersion: 'v3', provider: 'mock', modelId: 'm', doGenerate: answer, doStream: answer }
  return { model: model as unknown as ResolvedModel, calls }
}

/** Call one method of a wrapped model, and read back both the call it made and the chunks it gave. */
async function call(
  model: ResolvedModel,
  method: 'doGenerate' | 'doStream',
  options: Call
): Promise<{ type: string; toolName?: string }[]> {
  const invoke = (model as unknown as Record<typeof method, (options: Call) => Promise<{ stream: ReadableStream }>>)[method]
  const { stream } = await invoke(options)
  const chunks: { type: string; toolName?: string }[] = []
  for await (const chunk of stream as ReadableStream<{ type: string; toolName?: string }>) {
    chunks.push(chunk)
  }
  return chunks
}

describe('the renames a request amounts to', () => {
  const definitions: ToolDef[] = [{ name: 'getWeather', parametersJsonSchema: {} }]

  it('leaves a tool the core routed nowhere under its own name', () => {
    // Not a table the core hands back -- `forward` covers every tool it was given -- and the point of
    // the fallback is that a missing route is never read as a rename.
    const applied = { forward: new Map(), reverse: new Map() } as unknown as AppliedTools

    expect(toolRenames(definitions, applied)).toEqual({ toModel: new Map(), toCode: new Map() })
  })
})

describe('a model that speaks the managed names', () => {
  it('passes through a call that names no tool at all', async () => {
    const { model, calls } = stubModel([{ type: 'text-delta' }])
    const prompt = [{ role: 'user', content: 'hi' }]

    // Mastra sends neither declarations nor a named choice when the step offers no tools, and a text
    // part names nothing on the way back.
    const chunks = await call(renamingModel(model, RENAMES, CODE_ONLY), 'doGenerate', { prompt })

    expect(calls[0]).toEqual({ prompt })
    expect(chunks).toEqual([{ type: 'text-delta' }])
  })

  it('renames only the tools an override renamed', async () => {
    const { model, calls } = stubModel([])

    await call(renamingModel(model, RENAMES, CODE_ONLY), 'doStream', {
      tools: [{ name: 'getWeather' }, { name: 'sendEmail' }],
      prompt: [],
    })

    expect(calls[0]?.tools).toEqual([{ name: 'lookup_weather' }, { name: 'sendEmail' }])
  })

  it('is the model it wraps in every other respect', () => {
    const { model } = stubModel([])
    const wrapped = renamingModel(model, RENAMES, CODE_ONLY)

    // Mastra reads the version to decide whether it can run the step at all, and the provider and id
    // to label the span; a wrapper that answered differently would be a different model.
    expect(wrapped.specificationVersion).toBe('v3')
    expect(wrapped.provider).toBe('mock')
    expect(wrapped.modelId).toBe('m')
  })

  it('lets the wrapped model reach its own private state', async () => {
    // The one thing a `Proxy` gets wrong by default. Mastra's `ModelRouterLanguageModel` keeps its
    // transport in a `#private` field and reads it from a method the loop calls between steps; a trap
    // that forwards the proxy as the receiver makes that read throw `Cannot read private member ...
    // from an object whose class did not declare it`, which took down every renaming run against the
    // model router. So every read is made with the target as the receiver and every method comes back
    // bound to it.
    class PrivateModel {
      readonly specificationVersion = 'v3'
      readonly provider = 'mock'
      readonly modelId = 'm'
      readonly #transport = 'sse'
      getTransport(): string {
        return this.#transport
      }
      get transport(): string {
        return this.#transport
      }
      async doGenerate(): Promise<{ stream: ReadableStream }> {
        return Promise.resolve({
          stream: new ReadableStream({
            start: (controller) => {
              controller.close()
            },
          }),
        })
      }
    }
    const wrapped = renamingModel(new PrivateModel() as unknown as ResolvedModel, RENAMES, CODE_ONLY)
    const model = wrapped as unknown as { getTransport: () => string; transport: string }

    expect(model.getTransport()).toBe('sse')
    expect(model.transport).toBe('sse')
    // And reading a method twice gives the same function, as it does on the model itself.
    expect(model.getTransport).toBe(model.getTransport)
    // The call methods are still the wrapping ones, and still work.
    await expect(call(wrapped, 'doGenerate', { prompt: [] })).resolves.toEqual([])
  })
})
