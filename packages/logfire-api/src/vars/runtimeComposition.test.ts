import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { configureVariables, defineVar, getVariableProvider, variablesClear, variablesValidate } from './index'
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

  it('treats a variable named like an Object.prototype member as unconfigured', async () => {
    configureVariables({
      config: config({
        main: {
          labels: { prod: { serialized_value: JSON.stringify('Hello'), version: 1 } },
          name: 'main',
          overrides: [],
          rollout: { labels: { prod: 1 } },
        },
      }),
      instrument: false,
    })

    // An ordinary absent name is the reference point: it reports `code_default`.
    await expect(defineVar('absentname', { default: 'fallback' }).get()).resolves.toMatchObject({
      reason: 'code_default',
      value: 'fallback',
    })

    // These used to find the inherited member, hand it back as a variable config, and fail
    // somewhere downstream, reporting `other_error` for a name nobody configured.
    const inherited = await Promise.all(
      ['constructor', 'valueOf', 'hasOwnProperty'].map(async (name) => defineVar(name, { default: 'fallback' }).get())
    )
    expect(inherited.map((resolved) => resolved.reason)).toEqual(['code_default', 'code_default', 'code_default'])
    expect(inherited.map((resolved) => resolved.value)).toEqual(['fallback', 'fallback', 'fallback'])
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

  it('accepts the deepest chain composition can expand and refuses the next one in both walks', async () => {
    // A chain of n variables is n-1 hops. `expandNamedReference` refuses at
    // `depth >= MAX_COMPOSITION_DEPTH`, and the validation walks compare with `>` because they
    // start one level higher, so the two agree on where the limit falls. These are the boundary
    // cases that keep them agreeing.
    const chain = (count: number): VariablesConfig['variables'] => {
      const variables: VariablesConfig['variables'] = {}
      for (let index = 0; index < count; index++) {
        const value = index === count - 1 ? 'end' : `@{v${String(index + 1)}}@`
        variables[`v${String(index)}`] = {
          labels: { prod: { serialized_value: JSON.stringify(value), version: 1 } },
          name: `v${String(index)}`,
          overrides: [],
          rollout: { labels: { prod: 1 } },
        }
      }
      return variables
    }
    const probe = async (count: number) => {
      variablesClear()
      configureVariables({ config: config(chain(count)), instrument: false })
      const root = defineVar('v0', { default: 'code-default' })
      const report = await variablesValidate([root])
      return { referenceErrors: report.referenceErrors, resolved: await root.get() }
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    // 21 variables is 20 hops, the deepest chain composition expands.
    const deepest = await probe(21)
    expect(deepest.referenceErrors).toEqual([])
    expect(deepest.resolved.value).toBe('end')
    expect(deepest.resolved.reason).toBe('resolved')

    // 22 variables is 21 hops. Validation reports it and composition refuses it, so a config
    // that passes validation never fails later at resolve time.
    const tooDeep = await probe(22)
    expect(tooDeep.referenceErrors).toEqual([
      `Variable 'v0' reference graph exceeded maximum depth of 20 via ${Array.from({ length: 22 }, (_unused, index) => `v${String(index)}`).join(' -> ')}`,
    ])
    expect(tooDeep.resolved.value).toBe('code-default')
    expect(tooDeep.resolved.reason).toBe('other_error')
    expect((tooDeep.resolved.exception as Error).message).toBe(
      'VariableCompositionDepthError: Variable composition exceeded maximum depth of 20'
    )
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
