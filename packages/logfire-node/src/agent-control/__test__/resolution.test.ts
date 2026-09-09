/* eslint-disable @typescript-eslint/require-await -- `run` takes an async callback; several of these have nothing to await. */
import { context, propagation } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { beforeAll, describe, expect, it } from 'vite-plus/test'

import { AgentControl, currentResolution, UnmatchedConfigError, useResolution } from '../index'
import type { Resolution } from '../index'
import { captureWarnings, emptyVariable, publishedValue, useLocalVariables, useNoVariables } from './helpers'

const warnings = captureWarnings()

// Baggage only propagates into a callback once a context manager is registered, which `logfire.configure`
// does in a real process. Registering one here is what lets the test observe what a span would see.
beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
})

/** The baggage entry the Logfire SDK writes for a resolved variable, as seen from inside `run`. */
function baggageFor(variableName: string): string | undefined {
  return propagation.getBaggage(context.active())?.getEntry(`logfire.variables.${variableName}`)?.value
}

describe('AgentControl.resolution', () => {
  it('reports the value, the label, the version, and how resolution ended', async () => {
    useLocalVariables(publishedValue('agent__checkout', { model: 'openai:gpt-5.6-sol' }, 'production'))
    expect(await new AgentControl('checkout', { label: 'production' }).resolution()).toEqual({
      config: { model: 'openai:gpt-5.6-sol' },
      variableName: 'agent__checkout',
      label: 'production',
      version: 1,
      reason: 'resolved',
    })
  })

  it('reports a null config with the reason that explains it', async () => {
    // A variable that exists with nothing targeted, and one that does not exist at all, both fall
    // back to the code default -- so `reason` is what an adapter logs, and `config: null` is what it
    // acts on. Neither is worth a warning: an agent nobody has configured yet is the normal state.
    useLocalVariables(emptyVariable('agent__checkout'))
    const known: Resolution = await new AgentControl('checkout').resolution()
    expect(known).toEqual({
      config: null,
      variableName: 'agent__checkout',
      label: null,
      version: null,
      reason: 'code_default',
    })

    useLocalVariables()
    expect((await new AgentControl('checkout').resolution()).reason).toBe('code_default')

    // Variables switched off entirely lands in the same place, and is just as unremarkable.
    useNoVariables()
    expect((await new AgentControl('checkout').resolution()).reason).toBe('code_default')
    expect(warnings.messages).toEqual([])
  })

  it('reports null for every field but the reason when the provider is unreachable', async () => {
    useNoVariables()
    const provider = (await import('logfire/vars')).getVariableProvider() as {
      getSerializedValue: () => Promise<never>
    }
    provider.getSerializedValue = async () => Promise.reject(new Error('connection refused'))
    expect(await new AgentControl('checkout').resolution()).toEqual({
      config: null,
      variableName: 'agent__checkout',
      label: null,
      version: null,
      reason: 'other_error',
    })
    expect(warnings.messages).toHaveLength(1)
  })
})

describe('AgentControl.resolve', () => {
  it('is sugar over the same path, warnings included', async () => {
    useLocalVariables(publishedValue('agent__checkout', { model: 'openai:gpt-5.6-sol' }))
    const control = new AgentControl('checkout')
    expect(await control.resolve()).toEqual((await control.resolution()).config)
  })
})

describe('AgentControl.run', () => {
  it('hands the callback the resolution and returns what it returns', async () => {
    useLocalVariables(publishedValue('agent__checkout', { model: 'openai:gpt-5.6-sol' }, 'production'))
    const control = new AgentControl('checkout', { label: 'production' })
    const seen: Resolution[] = []
    const result = await control.run(async (resolution) => {
      seen.push(resolution)
      return 'ran'
    })
    expect(result).toBe('ran')
    expect(seen).toEqual([
      {
        config: { model: 'openai:gpt-5.6-sol' },
        variableName: 'agent__checkout',
        label: 'production',
        version: 1,
        reason: 'resolved',
      },
    ])
  })

  it("puts the selected label on the SDK's own baggage key for the duration of the callback", async () => {
    useLocalVariables(publishedValue('agent__checkout', { model: 'openai:gpt-5.6-sol' }, 'production'))
    expect(baggageFor('agent__checkout')).toBeUndefined()
    const inside = await new AgentControl('checkout', { label: 'production' }).run(async () => baggageFor('agent__checkout'))
    // This is what makes a trace say which published version drove the run.
    expect(inside).toBe('production')
    // And it is scoped to the callback, not leaked into whatever runs next.
    expect(baggageFor('agent__checkout')).toBeUndefined()
  })

  it('marks a run that fell back to code, rather than leaving the trace silent about it', async () => {
    useLocalVariables()
    const inside = await new AgentControl('checkout').run(async () => baggageFor('agent__checkout'))
    expect(inside).toBe('<code_default>')
  })

  it('resolves once, so the config the callback sees and the label its spans carry cannot disagree', async () => {
    useLocalVariables(publishedValue('agent__checkout', { model: 'openai:gpt-5.6-sol' }, 'production'))
    const provider = (await import('logfire/vars')).getVariableProvider()
    // eslint-disable-next-line @typescript-eslint/unbound-method -- captured to be re-bound on the next line.
    const read = provider.getSerializedValueForLabel
    if (read === undefined) {
      throw new Error('the local provider is expected to read values through getSerializedValueForLabel')
    }
    const original = read.bind(provider)
    let reads = 0
    provider.getSerializedValueForLabel = (...args: Parameters<typeof original>): ReturnType<typeof original> => {
      reads += 1
      return original(...args)
    }
    await new AgentControl('checkout', { label: 'production' }).run(async ({ config, label }) => {
      expect(config).not.toBeNull()
      expect(label).toBe('production')
    })
    expect(reads).toBe(1)
  })

  it("lets the callback's failure through, since it is the run failing and not the config", async () => {
    useLocalVariables()
    await expect(new AgentControl('checkout').run(async () => Promise.reject(new Error('the run failed')))).rejects.toThrow(
      'the run failed'
    )
  })
})

describe('AgentControl.reportUnmatched', () => {
  it("routes an adapter's own report through this control's policy", () => {
    const message = 'Managed agent config sets a model, which this framework cannot switch; it is not applied.'
    new AgentControl('checkout', { onUnmatched: 'ignore' }).reportUnmatched(message)
    expect(warnings.messages).toEqual([])

    new AgentControl('checkout').reportUnmatched(message)
    expect(warnings.messages).toEqual([message])

    // Deduplicated per process like every other report, so an adapter can call it per request.
    new AgentControl('checkout').reportUnmatched(message)
    expect(warnings.messages).toEqual([message])

    expect(() => {
      new AgentControl('checkout', { onUnmatched: 'error' }).reportUnmatched(message)
    }).toThrow(UnmatchedConfigError)
  })
})

describe('one resolution, two hooks', () => {
  it('answers with the resolution the surrounding scope installed', async () => {
    useLocalVariables(publishedValue('agent__checkout', { model: 'openai:gpt-5.6-sol' }, 'production'))
    const control = new AgentControl('checkout', { label: 'production' })
    expect(control.currentResolution()).toBeNull()

    const resolution = await control.resolution()
    const inside = await useResolution(resolution, () => control.currentResolution())
    // The seam for a framework that hands an adapter two hooks per run: resolving in each of them can
    // send prompt A with model B while the telemetry attributes the request to B alone.
    expect(inside).toBe(resolution)
    expect(control.currentResolution()).toBeNull()
  })

  it('is installed by `run` too, so the common case needs no second call', async () => {
    useLocalVariables(publishedValue('agent__checkout', { model: 'openai:gpt-5.6-sol' }, 'production'))
    const control = new AgentControl('checkout', { label: 'production' })
    const inside = await control.run(async (resolution) => {
      expect(control.currentResolution()).toBe(resolution)
      return currentResolution('agent__checkout')
    })
    expect(inside?.config).toEqual({ model: 'openai:gpt-5.6-sol' })
  })

  it('keeps answering about each agent when a managed agent runs inside another', async () => {
    useLocalVariables({
      variables: {
        ...publishedValue('agent__outer', { model: 'openai:gpt-5.6-sol' }).variables,
        ...publishedValue('agent__inner', { model: 'anthropic:claude-fable-5-1' }).variables,
      },
    })
    const outer = new AgentControl('outer', { label: 'production' })
    const inner = new AgentControl('inner', { label: 'production' })
    await useResolution(await outer.resolution(), async () => {
      await useResolution(await inner.resolution(), () => {
        // A handoff, a subagent, or a tool that runs another managed agent puts a second scope inside
        // the first, and neither may start answering about the other.
        expect(outer.currentResolution()?.config).toEqual({ model: 'openai:gpt-5.6-sol' })
        expect(inner.currentResolution()?.config).toEqual({ model: 'anthropic:claude-fable-5-1' })
      })
      expect(inner.currentResolution()).toBeNull()
    })
  })

  it('re-establishes the telemetry of a resolution carried in a framework’s own state', async () => {
    useLocalVariables(publishedValue('agent__checkout', { model: 'openai:gpt-5.6-sol' }, 'production'))
    const resolution = await new AgentControl('checkout', { label: 'production' }).resolution()
    // Rebuilt from the resolution rather than held, so an adapter that carried it through its
    // framework's per-run state still gets spans that say which version produced them.
    expect(await useResolution(resolution, () => baggageFor('agent__checkout'))).toBe('production')
  })

  it('reports a run that fell back to code, which has no label or version to carry', async () => {
    useLocalVariables()
    const resolution = await new AgentControl('checkout').resolution()
    expect(resolution.label).toBeNull()
    expect(await useResolution(resolution, () => baggageFor('agent__checkout'))).toBe('<code_default>')
  })
})
