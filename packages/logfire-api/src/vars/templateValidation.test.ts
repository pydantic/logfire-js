import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  configureVariables,
  defineTemplateVar,
  defineVar,
  getVariableProvider,
  variablesPullConfig,
  variablesClear,
  variablesPush,
  variablesValidate,
} from './index'
import type { VariablesConfig } from './index'
import { extractTemplatePaths, validateTemplateInputs } from './templateValidation'

const config = (variables: VariablesConfig['variables']): VariablesConfig => ({ variables })

describe('variable template validation', () => {
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

  it('extracts common Handlebars paths from templates', () => {
    expect(extractTemplatePaths('Hello {{user.name}} {{#if beta}}yes{{/if}}')).toEqual(['user.name', 'beta'])
  })

  it('allows template paths covered by object-valued additionalProperties', () => {
    expect(
      validateTemplateInputs(
        JSON.stringify('Hello {{name}} {{extra}}'),
        {
          additionalProperties: { type: 'string' },
          properties: { name: { type: 'string' } },
          type: 'object',
        },
        'prompt',
        'prod'
      )
    ).toEqual([])
  })

  it('reports template paths missing from template_inputs_schema', async () => {
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

    const report = await variablesValidate([prompt])

    expect(report.isValid).toBe(false)
    expect(report.templateFieldIssues).toEqual([
      {
        fieldName: 'missing',
        foundInLabel: 'prod',
        foundInVariable: 'prompt',
        message: "Template path 'missing' is not present in template_inputs_schema",
        referencePath: ['prompt'],
        rootVariable: 'prompt',
      },
    ])
  })

  it('validates templates after transitive composition', async () => {
    configureVariables({
      config: config({
        fragment: {
          labels: { prod: { serialized_value: JSON.stringify('{{unknown}}'), version: 1 } },
          name: 'fragment',
          overrides: [],
          rollout: { labels: { prod: 1 } },
        },
        prompt: {
          labels: { prod: { serialized_value: JSON.stringify('Use @{fragment}@'), version: 1 } },
          name: 'prompt',
          overrides: [],
          rollout: { labels: { prod: 1 } },
        },
      }),
      instrument: false,
    })
    const prompt = defineTemplateVar<string, { known: string }>('prompt', {
      default: 'Use {{known}}',
      templateInputsSchema: {
        properties: { known: { type: 'string' } },
        type: 'object',
      },
    })

    const report = await variablesValidate([prompt])

    expect(report.templateFieldIssues).toMatchObject([
      {
        fieldName: 'unknown',
        foundInLabel: 'prod',
        foundInVariable: 'fragment',
        referencePath: ['prompt', 'fragment'],
        rootVariable: 'prompt',
      },
    ])
  })

  it('reports missing references and cycles', async () => {
    configureVariables({
      config: config({
        cyclic: {
          labels: { prod: { serialized_value: JSON.stringify('@{cyclic}@'), version: 1 } },
          name: 'cyclic',
          overrides: [],
          rollout: { labels: { prod: 1 } },
        },
        prompt: {
          labels: { prod: { serialized_value: JSON.stringify('@{missing}@'), version: 1 } },
          name: 'prompt',
          overrides: [],
          rollout: { labels: { prod: 1 } },
        },
      }),
      instrument: false,
    })
    const prompt = defineVar('prompt', { default: '' })
    const cyclic = defineVar('cyclic', { default: '' })

    const report = await variablesValidate([prompt, cyclic])

    expect(report.referenceErrors).toEqual([
      "Variable 'prompt' references missing variable 'missing' via prompt -> missing",
      'Circular variable reference: cyclic -> cyclic',
    ])
    expect(report.referenceCycles).toEqual(['Circular variable reference: cyclic -> cyclic'])
    expect(report.isValid).toBe(false)
  })

  it('strict push returns a blocked result for reference and template validation issues', async () => {
    configureVariables({
      config: config({
        prompt: {
          labels: { prod: { serialized_value: JSON.stringify('Hello {{missing}} @{unknown}@'), version: 1 } },
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

    await expect(variablesPush([prompt], { strict: true })).resolves.toMatchObject({
      blocked: true,
      blockedBy: ['reference_errors'],
      changes: [{ action: 'update', name: 'prompt' }],
      dryRun: false,
    })
  })

  it('non-strict push warns and applies reference and template validation issues', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    configureVariables({
      config: config({
        prompt: {
          labels: { prod: { serialized_value: JSON.stringify('Hello {{missing}} @{unknown}@'), version: 1 } },
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

    await expect(variablesPush([prompt])).resolves.toMatchObject({
      blocked: false,
      blockedBy: [],
      changes: [{ action: 'update', name: 'prompt' }],
      dryRun: false,
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Variable push reference warning'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Variable push template warning'))
    await expect(variablesPullConfig()).resolves.toMatchObject({
      variables: {
        prompt: {
          template_inputs_schema: {
            properties: { name: { type: 'string' } },
            type: 'object',
          },
        },
      },
    })
  })
})
