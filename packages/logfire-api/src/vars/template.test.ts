import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  configureVariables,
  defineTemplateVar,
  defineVar,
  getVariableProvider,
  ResolvedVariable,
  TemplateInputsMismatchError,
  VariableRenderError,
  variablesClear,
} from './index'
import type { VariablesConfig } from './index'

const config = (variables: VariablesConfig['variables']): VariablesConfig => ({ variables })

describe('variable template rendering', () => {
  beforeEach(() => {
    variablesClear()
    configureVariables(false)
  })

  afterEach(async () => {
    await getVariableProvider().shutdown?.()
    vi.restoreAllMocks()
    variablesClear()
    configureVariables(false)
  })

  it('renders resolved provider values through ResolvedVariable.render()', async () => {
    configureVariables({
      config: config({
        prompt: {
          labels: { prod: { serialized_value: JSON.stringify('Hello {{name}}'), version: 1 } },
          name: 'prompt',
          overrides: [],
          rollout: { labels: { prod: 1 } },
        },
      }),
      instrument: false,
    })
    const prompt = defineVar('prompt', { default: 'Hello' })

    const resolved = await prompt.get()

    expect(resolved.render({ name: 'Ada' })).toBe('Hello Ada')
  })

  it('renders string leaves in objects and arrays without HTML escaping inputs', async () => {
    configureVariables({
      config: config({
        prompt_config: {
          labels: { prod: { serialized_value: JSON.stringify({ list: ['{{name}}'], text: 'Hi {{name}}' }), version: 1 } },
          name: 'prompt_config',
          overrides: [],
          rollout: { labels: { prod: 1 } },
        },
      }),
      instrument: false,
    })
    const promptConfig = defineVar('prompt_config', { default: { list: [''], text: '' } })

    const resolved = await promptConfig.get()

    expect(resolved.render({ name: '<Ada>' })).toEqual({ list: ['<Ada>'], text: 'Hi <Ada>' })
  })

  it('throws VariableRenderError when no serialized value is available', () => {
    const resolved = new ResolvedVariable({ name: 'local_only', reason: 'context_override', value: 'value' })

    expect(() => resolved.render({})).toThrow(VariableRenderError)
  })

  it('defineTemplateVar composes, renders, and parses in one get call', async () => {
    configureVariables({
      config: config({
        prompt: {
          labels: { prod: { serialized_value: JSON.stringify('Write @{tone}@ to {{user.name}}'), version: 1 } },
          name: 'prompt',
          overrides: [],
          rollout: { labels: { prod: 1 } },
        },
        tone: {
          labels: { prod: { serialized_value: JSON.stringify('kindly'), version: 1 } },
          name: 'tone',
          overrides: [],
          rollout: { labels: { prod: 1 } },
        },
      }),
      instrument: false,
    })
    const prompt = defineTemplateVar<string, { user: { name: string } }>('prompt', {
      default: 'Hello {{user.name}}',
      templateInputsSchema: {
        properties: { user: { properties: { name: { type: 'string' } }, type: 'object' } },
        type: 'object',
      },
    })

    const resolved = await prompt.get({ user: { name: 'Ada' } })

    expect(resolved.value).toBe('Write kindly to Ada')
    expect(resolved.composedFrom).toMatchObject([{ name: 'tone' }])
  })

  it('defineTemplateVar falls back and records invalid remote template errors', async () => {
    configureVariables({
      config: config({
        prompt: {
          labels: { prod: { serialized_value: JSON.stringify('Hello {{#if name}}'), version: 1 } },
          name: 'prompt',
          overrides: [],
          rollout: { labels: { prod: 1 } },
        },
      }),
      instrument: false,
    })
    const prompt = defineTemplateVar<string, { name: string }>('prompt', { default: 'fallback' })

    const resolved = await prompt.get({ name: 'Ada' })

    expect(resolved).toMatchObject({ label: 'prod', reason: 'other_error', value: 'fallback', version: 1 })
    expect(resolved.exception).toBeInstanceOf(VariableRenderError)
  })

  it('defineTemplateVar falls back and records invalid default template errors', async () => {
    configureVariables(false)
    const prompt = defineTemplateVar<string, { name: string }>('bad_default_prompt', { default: 'Hello {{#if name}}' })

    const resolved = await prompt.get({ name: 'Ada' })

    expect(resolved).toMatchObject({ reason: 'other_error', value: 'Hello {{#if name}}' })
    expect(resolved.exception).toBeInstanceOf(VariableRenderError)
  })

  it('does not invoke callable defaults twice when template rendering fails', async () => {
    configureVariables(false)
    let calls = 0
    const prompt = defineTemplateVar<string, { name: string }>('bad_callable_default_prompt', {
      codec: {
        parse(value) {
          if (typeof value !== 'string') {
            throw new TypeError('Expected string')
          }
          return value
        },
      },
      default: () => {
        calls += 1
        return 'Hello {{#if name}}'
      },
    })

    const resolved = await prompt.get({ name: 'Ada' })

    expect(calls).toBe(1)
    expect(resolved).toMatchObject({ reason: 'other_error', value: 'Hello {{#if name}}' })
    expect(resolved.exception).toBeInstanceOf(VariableRenderError)
  })

  it('renders template defaults and trusts schema-mismatched inputs at runtime', async () => {
    configureVariables(false)
    const prompt = defineTemplateVar<string>('fallback_prompt', {
      default: 'Hello {{name}}',
      templateInputsSchema: {
        properties: { name: { type: 'string' } },
        type: 'object',
      },
    })

    await expect(prompt.get({ missing: 'Ada' })).resolves.toMatchObject({ reason: 'code_default', value: 'Hello ' })
  })

  it('warns by default when resolved templates reference fields outside the schema', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    configureVariables({
      config: config({
        prompt: {
          labels: { prod: { serialized_value: JSON.stringify('Hello {{missing}}'), version: 1 } },
          name: 'prompt',
          overrides: [],
          rollout: { labels: { prod: 1 } },
        },
      }),
      instrument: false,
    })
    const prompt = defineTemplateVar<string, { name: string }>('prompt', {
      default: 'Hello {{name}}',
      templateInputsSchema: {
        properties: { name: { type: 'string' } },
        type: 'object',
      },
    })

    await expect(prompt.get({ name: 'Ada' })).resolves.toMatchObject({ value: 'Hello ' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Template path 'missing' is not present"))
  })

  it('throws for template mismatch policy error without falling back to the default', async () => {
    configureVariables({
      config: config({
        prompt: {
          labels: { prod: { serialized_value: JSON.stringify('Hello {{missing}}'), version: 1 } },
          name: 'prompt',
          overrides: [],
          rollout: { labels: { prod: 1 } },
        },
      }),
      instrument: false,
      templateMismatchPolicy: 'error',
    })
    const prompt = defineTemplateVar<string, { name: string }>('prompt', {
      default: 'fallback',
      templateInputsSchema: {
        properties: { name: { type: 'string' } },
        type: 'object',
      },
    })

    await expect(prompt.get({ name: 'Ada' })).rejects.toBeInstanceOf(TemplateInputsMismatchError)
  })

  it('lets per-variable template mismatch policy relax the runtime policy', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    configureVariables({
      config: config({
        prompt: {
          labels: { prod: { serialized_value: JSON.stringify('Hello {{missing}}'), version: 1 } },
          name: 'prompt',
          overrides: [],
          rollout: { labels: { prod: 1 } },
        },
      }),
      instrument: false,
      templateMismatchPolicy: 'error',
    })
    const prompt = defineTemplateVar<string, { name: string }>('prompt', {
      default: 'fallback',
      templateInputsSchema: {
        properties: { name: { type: 'string' } },
        type: 'object',
      },
      templateMismatchPolicy: 'ignore',
    })

    await expect(prompt.get({ name: 'Ada' })).resolves.toMatchObject({ value: 'Hello ' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns when a plain variable statically composes a template variable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    defineTemplateVar<string, { name: string }>('fragment', {
      default: 'Hello {{name}}',
      templateInputsSchema: {
        properties: { name: { type: 'string' } },
        type: 'object',
      },
    })
    defineVar('plain_prompt', { default: 'Use @{fragment}@' })

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("plain variable 'plain_prompt' composes template variable 'fragment'"))
  })

  it('warns when a template variable is declared after a plain variable that composes it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    defineVar('plain_prompt', { default: 'Use @{fragment}@' })
    defineTemplateVar<string, { name: string }>('fragment', {
      default: 'Hello {{name}}',
      templateInputsSchema: {
        properties: { name: { type: 'string' } },
        type: 'object',
      },
    })

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("plain variable 'plain_prompt' composes template variable 'fragment'"))
  })
})
