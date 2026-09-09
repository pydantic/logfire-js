import { configureVariables, getVariableProvider } from 'logfire/vars'
import type { SerializedResolvedVariable, VariableConfig } from 'logfire/vars'
import { describe, expect, it } from 'vite-plus/test'

import { AgentControl, AGENT_CONFIG_JSON_SCHEMA, buildBaseline } from '../index'
import { captureWarnings, emptyVariable, publishedValue, settle, storedConfigFor, useLocalVariables, useNoVariables } from './helpers'

const warnings = captureWarnings()

/** A provider that fails every read, the way an unreachable Logfire API does. */
function useBrokenProvider(): void {
  configureVariables(false)
  const provider = getVariableProvider() as {
    getSerializedValue: () => Promise<SerializedResolvedVariable>
  }
  provider.getSerializedValue = async () => Promise.reject(new Error('connection refused'))
}

describe('AgentControl', () => {
  it('backs an agent with the `agent__<name>` variable the Logfire UI lists', () => {
    const control = new AgentControl('checkout_assistant')
    expect(control.name).toBe('checkout_assistant')
    expect(control.variableName).toBe('agent__checkout_assistant')
    expect(control.onUnmatched).toBe('warn')
    expect(control.label).toBeUndefined()
  })

  it('refuses a name with no variable key in it, rather than pointing every agent at one config', () => {
    expect(() => new AgentControl('')).toThrow(/has nothing a variable key can be made of/u)
    expect(() => new AgentControl('   ')).toThrow(/has nothing a variable key can be made of/u)
  })

  it('keeps the display name verbatim and normalizes only the variable key', () => {
    // Two SDKs and the Logfire UI have to land on one variable for one agent, so the key is
    // normalized; the name a person recognizes the agent by is not.
    const control = new AgentControl('Checkout Assistant')
    expect(control.name).toBe('Checkout Assistant')
    expect(control.variableName).toBe('agent__checkout_assistant')
    expect(new AgentControl('checkout-assistant').variableName).toBe(control.variableName)
    expect(new AgentControl('  checkout  ').name).toBe('checkout')
  })

  it('shares one variable between two controls for the same agent', () => {
    // `defineVar` refuses a name it has already registered, and two controls for one agent is an
    // ordinary thing for an adapter to end up with.
    expect(() => [new AgentControl('twice'), new AgentControl('twice')]).not.toThrow()
  })

  it("falls back to an unregistered variable when the name is already someone else's", async () => {
    const { defineVar } = await import('logfire/vars')
    defineVar('agent__taken', { default: {} })
    useLocalVariables(publishedValue('agent__taken', { model: 'openai:gpt-5.6-sol' }))
    // Still resolves: the registry entry is theirs, but the variable reads the same name through the
    // same provider.
    expect(await new AgentControl('taken', { label: 'production' }).resolve()).toEqual({
      model: 'openai:gpt-5.6-sol',
    })
  })

  describe('resolve', () => {
    it('returns the published value for the label it was given', async () => {
      useLocalVariables(publishedValue('agent__checkout', { instructions: 'Be brief.', model: 'openai:gpt-5.6-sol' }, 'production'))
      const control = new AgentControl('checkout', { label: 'production' })
      expect(await control.resolve()).toEqual({
        instructions: 'Be brief.',
        model: 'openai:gpt-5.6-sol',
      })
    })

    it("returns the rollout's choice when no label is pinned", async () => {
      useLocalVariables(publishedValue('agent__checkout', { model: 'openai:gpt-5.6-sol' }, 'production'))
      expect(await new AgentControl('checkout').resolve()).toEqual({ model: 'openai:gpt-5.6-sol' })
    })

    it('returns null when nothing is published, so an adapter can tell managed from unmanaged', async () => {
      useLocalVariables(emptyVariable('agent__checkout'))
      expect(await new AgentControl('checkout').resolve()).toBeNull()
      expect(warnings.messages).toEqual([])
    })

    it('returns null when the variable does not exist at all', async () => {
      useLocalVariables()
      expect(await new AgentControl('checkout').resolve()).toBeNull()
      expect(warnings.messages).toEqual([])
    })

    it('returns null when variables are switched off', async () => {
      useNoVariables()
      expect(await new AgentControl('checkout').resolve()).toBeNull()
      expect(warnings.messages).toEqual([])
    })

    it('applies the lenient parse, so one bad field does not un-manage the rest', async () => {
      useLocalVariables(
        publishedValue('agent__checkout', {
          model: 'openai:gpt-5.6-sol',
          settings: { temperature: 'warm', max_tokens: 100 },
        })
      )
      expect(await new AgentControl('checkout').resolve()).toEqual({
        model: 'openai:gpt-5.6-sol',
        settings: { max_tokens: 100 },
      })
      expect(warnings.messages[0]).toContain("setting 'temperature' has invalid value")
    })

    describe('when the provider is down', () => {
      it('returns null and warns once, so the agent keeps running on code', async () => {
        useBrokenProvider()
        const control = new AgentControl('checkout')
        expect(await control.resolve()).toBeNull()
        expect(await control.resolve()).toBeNull()
        expect(warnings.messages).toEqual([
          "Logfire managed variable 'agent__checkout' could not be resolved (other_error); running on the code-defined agent.",
        ])
      })
    })

    it('returns null and warns when the published value itself cannot be resolved', async () => {
      // Nothing this package writes can land here -- `parseAgentConfig` never throws -- but a
      // composition reference the value cannot expand does, and the agent runs on code either way.
      useLocalVariables(publishedValue('agent__checkout', '@{no_such_variable}@'))
      expect(await new AgentControl('checkout', { label: 'production' }).resolve()).toBeNull()
      expect(warnings.messages).toContain(
        "Logfire managed variable 'agent__checkout' could not be resolved (other_error); running on the code-defined agent."
      )
    })
  })

  describe('publishBaseline', () => {
    const baseline = buildBaseline({
      instructions: [{ id: 'agent', text: 'You are a checkout assistant.', dynamic: false }],
      model: 'openai:gpt-5.6-sol',
    })
    const example = JSON.stringify(baseline, null, 2)

    it('creates the variable with the shared JSON schema when it does not exist', async () => {
      useLocalVariables()
      new AgentControl('checkout').publishBaseline(baseline)
      await settle()
      const stored = storedConfigFor('agent__checkout')
      expect(stored?.name).toBe('agent__checkout')
      expect(stored?.example).toBe(example)
      // The stored schema is what the Logfire backend validates every written value against, so
      // whichever side creates the variable first fixes the contract for the other.
      expect(stored?.json_schema).toEqual(AGENT_CONFIG_JSON_SCHEMA)
      expect(warnings.messages).toEqual([])
    })

    it('publishes exactly the canonical JSON of the baseline', async () => {
      useLocalVariables()
      new AgentControl('checkout').publishBaseline(baseline)
      await settle()
      expect(storedConfigFor('agent__checkout')?.example).toMatchInlineSnapshot(`
        "{
          "instructions": [
            {
              "id": "agent",
              "instructions": "You are a checkout assistant.",
              "dynamic": false
            }
          ],
          "model": "openai:gpt-5.6-sol"
        }"
      `)
    })

    it('syncs only `example` on a variable that already exists', async () => {
      useLocalVariables(
        emptyVariable('agent__checkout', {
          example: '{"model": "stale"}',
          description: 'Set by hand in the Logfire UI.',
          labels: {
            production: { version: 3, serialized_value: '{"model":"openai:gpt-5.6-sol"}' },
          },
          rollout: { labels: { production: 1 } },
        })
      )
      new AgentControl('checkout').publishBaseline(baseline)
      await settle()
      const stored = storedConfigFor('agent__checkout')
      expect(stored?.example).toBe(example)
      // Every other field of the definition someone edited in the UI survives the write.
      expect(stored?.description).toBe('Set by hand in the Logfire UI.')
      expect(stored?.labels['production']).toEqual({
        version: 3,
        serialized_value: '{"model":"openai:gpt-5.6-sol"}',
      })
    })

    it('writes nothing when `example` already matches', async () => {
      useLocalVariables(emptyVariable('agent__checkout', { example }))
      const provider = getVariableProvider() as { updateVariable: unknown }
      const original = provider.updateVariable
      let updates = 0
      provider.updateVariable = (...args: unknown[]) => {
        updates += 1
        return (original as (...a: unknown[]) => unknown).apply(provider, args)
      }
      new AgentControl('checkout').publishBaseline(baseline)
      await settle()
      expect(updates).toBe(0)
    })

    it('runs at most once per process per variable, however many requests call it', async () => {
      useLocalVariables()
      const control = new AgentControl('checkout')
      control.publishBaseline(baseline)
      control.publishBaseline(buildBaseline({ model: 'anthropic:claude-fable-5-1' }))
      new AgentControl('checkout').publishBaseline(buildBaseline({ model: 'anthropic:claude-fable-5-1' }))
      await settle()
      // The first snapshot wins: the guard is marked before the work, so a second request cannot
      // schedule a duplicate write and a failure is not retried by every later run.
      expect(storedConfigFor('agent__checkout')?.example).toBe(example)
    })

    it('does nothing at all when it is switched off', async () => {
      useLocalVariables()
      new AgentControl('checkout', { publishBaseline: false }).publishBaseline(baseline)
      await settle()
      expect(storedConfigFor('agent__checkout')).toBeUndefined()
    })

    it('does nothing when variables are switched off, since there is nowhere to publish', async () => {
      useNoVariables()
      new AgentControl('checkout').publishBaseline(baseline)
      await settle()
      expect(warnings.messages).toEqual([])
    })

    it('warns and never throws when the write fails', async () => {
      useLocalVariables()
      const provider = getVariableProvider() as { createVariable: unknown }
      provider.createVariable = async () => Promise.reject(new Error('403 read-only token'))
      new AgentControl('checkout').publishBaseline(baseline)
      await settle()
      expect(warnings.messages).toEqual([
        "Failed to publish the code baseline for Logfire managed variable 'agent__checkout': 403 read-only token",
      ])
    })

    it('warns and never throws when the baseline will not serialize', async () => {
      useLocalVariables()
      const circular: Record<string, unknown> = {}
      circular['self'] = circular
      new AgentControl('checkout').publishBaseline({ settings: circular })
      await settle()
      expect(warnings.messages[0]).toContain("Failed to publish the code baseline for Logfire managed variable 'agent__checkout'")
      expect(storedConfigFor('agent__checkout')).toBeUndefined()
    })

    it('tolerates a provider with no write path at all', async () => {
      useLocalVariables()
      const provider = getVariableProvider() as {
        createVariable?: unknown
        updateVariable?: unknown
      }
      delete provider.createVariable
      delete provider.updateVariable
      new AgentControl('checkout').publishBaseline(baseline)
      await settle()
      expect(warnings.messages).toEqual([])
    })

    it('tolerates a provider that cannot be asked what it holds', async () => {
      useLocalVariables()
      const provider = getVariableProvider() as { getVariableConfig?: unknown }
      delete provider.getVariableConfig
      // Unanswerable reads as "not there", which creates rather than blindly overwriting.
      new AgentControl('checkout').publishBaseline(baseline)
      await settle()
      expect(storedConfigFor('agent__checkout')?.example).toBe(example)
    })

    it('treats a null definition the same as a missing one', async () => {
      useLocalVariables()
      const provider = getVariableProvider() as {
        getVariableConfig: unknown
        createVariable: unknown
      }
      provider.getVariableConfig = () => null
      let created: VariableConfig | undefined
      provider.createVariable = (config: VariableConfig) => {
        created = config
        return config
      }
      new AgentControl('checkout').publishBaseline(baseline)
      await settle()
      expect(created?.example).toBe(example)
    })

    it('writes back the read it took immediately before the write, never an earlier one', async () => {
      // The lost-update window is one HTTP round trip and cannot be closed from this side, so what
      // *can* be done is: never write a definition read before the decision to write. This test
      // stands in for the UI saving between the two reads -- the write must carry what that later
      // read returned, not what the first one did.
      useLocalVariables(emptyVariable('agent__checkout', { example: '{"model": "stale"}' }))
      const provider = getVariableProvider() as {
        getVariableConfig: (name: string) => VariableConfig | undefined
        updateVariable: (name: string, config: VariableConfig) => VariableConfig
      }
      const read = provider.getVariableConfig.bind(provider)
      let reads = 0
      provider.getVariableConfig = (name: string) => {
        reads += 1
        const config = read(name)
        // Between the existence check and the write, someone publishes in the Logfire UI.
        if (reads === 1 && config !== undefined) {
          return {
            ...config,
            labels: { production: { version: 7, serialized_value: '{"model":"openai:gpt-5.6-sol"}' } },
          }
        }
        return config
      }
      let written: VariableConfig | undefined
      provider.updateVariable = (_name: string, config: VariableConfig) => {
        written = config
        return config
      }
      new AgentControl('checkout').publishBaseline(baseline)
      await settle()
      expect(reads).toBe(2)
      // The freshly read definition, with only `example` changed -- not the one read a round trip
      // earlier, which is the object a stale write would have restored.
      expect(written?.labels['production']).toBeUndefined()
      expect(written?.example).toBe(example)
    })

    it('writes nothing when the variable vanished between the two reads', async () => {
      useLocalVariables(emptyVariable('agent__checkout', { example: '{"model": "stale"}' }))
      const provider = getVariableProvider() as {
        getVariableConfig: (name: string) => VariableConfig | undefined
        updateVariable: unknown
      }
      const read = provider.getVariableConfig.bind(provider)
      let reads = 0
      provider.getVariableConfig = (name: string) => (++reads === 1 ? read(name) : undefined)
      let updates = 0
      provider.updateVariable = () => {
        updates += 1
      }
      new AgentControl('checkout').publishBaseline(baseline)
      await settle()
      // Re-creating a variable someone just deleted is not this call's decision to make.
      expect(updates).toBe(0)
    })

    it('says on a new variable whether the example is the code or one observed request', async () => {
      useLocalVariables()
      new AgentControl('checkout').publishBaseline(baseline, { source: 'observed' })
      await settle()
      expect(storedConfigFor('agent__checkout')?.description).toContain('snapshotted from one request')

      useLocalVariables()
      new AgentControl('other').publishBaseline(baseline)
      await settle()
      expect(storedConfigFor('agent__other')?.description).toContain('the agent as written')
    })

    it('warns about a failure that is not an Error at all', async () => {
      useLocalVariables()
      const provider = getVariableProvider() as { createVariable: unknown }
      // Deliberately not an `Error`: a hand-rolled provider or a raw HTTP client can reject with a
      // bare string, and the warning has to name it rather than print `undefined`.
      const notAnError: unknown = '403 read-only token'
      // eslint-disable-next-line prefer-promise-reject-errors, @typescript-eslint/prefer-promise-reject-errors -- see above
      provider.createVariable = async () => Promise.reject(notAnError)
      new AgentControl('checkout').publishBaseline(baseline)
      await settle()
      expect(warnings.messages).toEqual([
        "Failed to publish the code baseline for Logfire managed variable 'agent__checkout': 403 read-only token",
      ])
    })
  })
})
