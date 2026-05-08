import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { configureVariables, defineVar, getVariableProvider, variablesClear } from './index'
import type { VariablesConfig } from './index'

const { spanMock, startSpanMock } = vi.hoisted(() => {
  const spanMock = {
    end: vi.fn<() => void>(),
    recordException: vi.fn<() => void>(),
    setAttribute: vi.fn<(_name: string, _value: unknown) => void>(),
  }
  return {
    spanMock,
    startSpanMock: vi.fn<() => typeof spanMock>(() => spanMock),
  }
})

vi.mock('../index', () => ({
  startSpan: startSpanMock,
}))

const config = (variables: VariablesConfig['variables']): VariablesConfig => ({ variables })

describe('variable composition instrumentation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    variablesClear()
    configureVariables(false)
  })

  afterEach(async () => {
    await getVariableProvider().shutdown?.()
    variablesClear()
    configureVariables(false)
  })

  it('records composed references on variable resolution spans', async () => {
    configureVariables({
      config: config({
        greeting: {
          labels: { prod: { serialized_value: JSON.stringify('Hello'), version: 1 } },
          name: 'greeting',
          overrides: [],
          rollout: { labels: { prod: 1 } },
        },
        prompt: {
          labels: { prod: { serialized_value: JSON.stringify('@{greeting}@ there'), version: 1 } },
          name: 'prompt',
          overrides: [],
          rollout: { labels: { prod: 1 } },
        },
      }),
    })
    const prompt = defineVar('prompt', { default: '' })

    const resolved = await prompt.get()

    expect(resolved.value).toBe('Hello there')
    expect(startSpanMock).toHaveBeenCalledWith('Resolve variable prompt', {
      attributes: {},
      name: 'prompt',
      targeting_key: undefined,
    })
    expect(spanMock.setAttribute).toHaveBeenCalledWith(
      'composed_from',
      JSON.stringify([{ name: 'greeting', version: 1, label: 'prod', reason: 'resolved', error: null }])
    )
  })

  it('flattens nested composition chains for the composed_from span attribute', async () => {
    configureVariables({
      config: config({
        outer: {
          labels: { prod: { serialized_value: JSON.stringify('@{inner}@'), version: 2 } },
          name: 'outer',
          overrides: [],
          rollout: { labels: { prod: 1 } },
        },
        inner: {
          labels: { prod: { serialized_value: JSON.stringify('inside'), version: 1 } },
          name: 'inner',
          overrides: [],
          rollout: { labels: { prod: 1 } },
        },
        prompt: {
          labels: { prod: { serialized_value: JSON.stringify('@{outer}@'), version: 3 } },
          name: 'prompt',
          overrides: [],
          rollout: { labels: { prod: 1 } },
        },
      }),
    })
    const prompt = defineVar('prompt', { default: '' })

    const resolved = await prompt.get()

    expect(resolved.value).toBe('inside')
    expect(spanMock.setAttribute).toHaveBeenCalledWith(
      'composed_from',
      JSON.stringify([{ name: 'outer', version: 2, label: 'prod', reason: 'resolved', error: null }])
    )
  })
})
