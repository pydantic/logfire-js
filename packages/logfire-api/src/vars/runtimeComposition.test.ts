import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { configureVariables, defineVar, getVariableProvider, variablesClear } from './index'
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
})
