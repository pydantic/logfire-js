import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { configureVariables, defineTemplateVar, defineVar, getVariableProvider, variablesClear, variablesValidate } from './index'
import type { VariableCodec, VariablesConfig } from './index'

const config = (variables: VariablesConfig['variables']): VariablesConfig => ({ variables })

const stringCodec: VariableCodec<string> = {
  parse(value: unknown): string {
    if (typeof value !== 'string') {
      throw new TypeError('Expected string')
    }
    return value
  },
}

describe('variable runtime composition parity', () => {
  beforeEach(() => {
    variablesClear()
    configureVariables(false)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await getVariableProvider().shutdown?.()
    variablesClear()
    configureVariables(false)
  })

  it('falls back to the variable code default when a provider value has a missing reference', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    configureVariables({
      config: config({
        main: {
          labels: { prod: { serialized_value: JSON.stringify('Hello @{missing}@'), version: 1 } },
          name: 'main',
          overrides: [],
          rollout: { labels: { prod: 1 } },
        },
      }),
      instrument: false,
    })
    const main = defineVar('main', { default: 'fallback' })

    const resolved = await main.get()

    expect(resolved).toMatchObject({ label: 'prod', reason: 'other_error', value: 'fallback', version: 1 })
    expect(resolved.exception).toBeInstanceOf(Error)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Variable 'main' composition failed; falling back to code default"))
  })

  it('composes a serializable code default when the provider has no selected value', async () => {
    configureVariables({
      config: config({
        main: {
          labels: {},
          name: 'main',
          overrides: [],
          rollout: { labels: {} },
        },
      }),
      instrument: false,
    })
    defineVar('greeting', { default: 'Hello' })
    const main = defineVar('main', { default: '@{greeting}@ fallback' })

    const resolved = await main.get()

    expect(resolved).toMatchObject({ reason: 'code_default', value: 'Hello fallback' })
    expect(resolved.composedFrom).toMatchObject([{ name: 'greeting', reason: 'code_default', value: '"Hello"' }])
  })

  it('renders unresolved references in code defaults as empty strings with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    configureVariables({ config: config({}), instrument: false })
    const main = defineVar('main', { default: 'Hello @{missing}@' })

    const resolved = await main.get()

    expect(resolved).toMatchObject({ reason: 'code_default', value: 'Hello ' })
    expect(resolved.composedFrom).toMatchObject([{ name: 'missing', reason: 'unrecognized_variable' }])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('code default has unresolved composition reference'))
  })

  it('composes top-level context overrides against provider values', async () => {
    configureVariables({
      config: config({
        greeting: {
          labels: { prod: { serialized_value: JSON.stringify('Hello'), version: 1 } },
          name: 'greeting',
          overrides: [],
          rollout: { labels: { prod: 1 } },
        },
        main: {
          labels: { prod: { serialized_value: JSON.stringify('@{greeting}@ World'), version: 1 } },
          name: 'main',
          overrides: [],
          rollout: { labels: { prod: 1 } },
        },
      }),
      instrument: false,
    })
    const main = defineVar('main', { default: 'fallback' })

    const resolved = await main.override('Hi @{greeting}@!', async () => await main.get())

    expect(resolved).toMatchObject({ reason: 'context_override', value: 'Hi Hello!' })
    expect(resolved.composedFrom).toMatchObject([{ name: 'greeting', reason: 'resolved', value: '"Hello"' }])
  })

  it('uses referenced variable context overrides during parent composition', async () => {
    configureVariables({
      config: config({
        greeting: {
          labels: { prod: { serialized_value: JSON.stringify('PROVIDER_GREETING'), version: 1 } },
          name: 'greeting',
          overrides: [],
          rollout: { labels: { prod: 1 } },
        },
        parent: {
          labels: { prod: { serialized_value: JSON.stringify('hello @{greeting}@'), version: 1 } },
          name: 'parent',
          overrides: [],
          rollout: { labels: { prod: 1 } },
        },
      }),
      instrument: false,
    })
    const greeting = defineVar('greeting', { default: 'code_default_greeting' })
    const parent = defineVar('parent', { default: 'fallback' })

    const resolved = await greeting.override('OVERRIDDEN_GREETING', async () => await parent.get())

    expect(resolved.value).toBe('hello OVERRIDDEN_GREETING')
    expect(resolved.composedFrom).toMatchObject([{ name: 'greeting', reason: 'context_override', value: '"OVERRIDDEN_GREETING"' }])
  })

  it('invokes callable defaults once per get across composition fallback paths', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let calls = 0
    configureVariables(false)
    const main = defineVar('main', {
      codec: stringCodec,
      default: () => {
        calls += 1
        return '@{missing}@'
      },
    })

    const resolved = await main.get()

    expect(resolved).toMatchObject({ reason: 'code_default', value: '' })
    expect(calls).toBe(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('code default has unresolved composition reference'))
  })

  it('returns undefined with one warning when a callable default throws and no provider value is usable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let calls = 0
    configureVariables(false)
    const main = defineVar<string | undefined>('main', {
      codec: {
        parse(value: unknown): string | undefined {
          return value === undefined || typeof value === 'string' ? value : undefined
        },
        serialize(value: string | undefined): string {
          return JSON.stringify(value)
        },
      },
      default: () => {
        calls += 1
        throw new Error('default unavailable')
      },
    })

    const resolved = await main.get()

    expect(resolved.reason).toBe('other_error')
    expect(resolved.value).toBeUndefined()
    expect(resolved.exception).toBeInstanceOf(Error)
    expect(calls).toBe(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('code default raised'))
  })
  it('validates the reference depth limit that composition enforces', async () => {
    const chain = (n: number): VariablesConfig['variables'] => {
      const variables: VariablesConfig['variables'] = {}
      for (let i = 0; i < n; i++) {
        variables[`v${String(i)}`] = {
          labels: { prod: { serialized_value: JSON.stringify(i === n - 1 ? 'end' : `@{v${String(i + 1)}}@`), version: 1 } },
          name: `v${String(i)}`,
          overrides: [],
          rollout: { labels: { prod: 1 } },
        }
      }
      return variables
    }
    const referenceErrors = async (links: number): Promise<string[]> => {
      variablesClear()
      configureVariables({ config: config(chain(links)), instrument: false })
      const report = await variablesValidate([defineVar('v0', { default: 'x' })])
      return report.referenceErrors
    }

    // 20 links is what `expandNamedReference` will expand, so validation must accept it.
    expect(await referenceErrors(20)).toEqual([])
    // 21 is one more than composition can expand, so validation has to say so rather than
    // reporting the config as valid and failing later at resolve time.
    expect(await referenceErrors(21)).toEqual([
      `Variable 'v0' reference graph exceeded maximum depth of 20 via ${Array.from({ length: 21 }, (_unused, index) => `v${String(index)}`).join(' -> ')}`,
    ])
  })
  it('stops the template-field walk where composition stops', async () => {
    // Same chain, but the deepest link carries a template path the root schema does not declare.
    const templateChain = (links: number): VariablesConfig['variables'] => {
      const variables: VariablesConfig['variables'] = {}
      for (let i = 0; i < links; i++) {
        const value = i === links - 1 ? 'Hello {{missing}}' : `@{v${String(i + 1)}}@`
        variables[`v${String(i)}`] = {
          labels: { prod: { serialized_value: JSON.stringify(value), version: 1 } },
          name: `v${String(i)}`,
          overrides: [],
          rollout: { labels: { prod: 1 } },
        }
      }
      return variables
    }
    const fieldNames = async (links: number): Promise<string[]> => {
      variablesClear()
      configureVariables({ config: config(templateChain(links)), instrument: false })
      const root = defineTemplateVar<string, { name: string }>('v0', {
        default: 'Hello {{name}}',
        templateInputsSchema: { properties: { name: { type: 'string' } }, type: 'object' },
      })
      const report = await variablesValidate([root])
      return report.templateFieldIssues.map((issue) => issue.fieldName)
    }

    // Reachable, so the unknown template path is reported.
    expect(await fieldNames(20)).toEqual(['missing'])
    // One hop past what composition will expand, so there is nothing to report about it.
    expect(await fieldNames(21)).toEqual([])
  })
})
