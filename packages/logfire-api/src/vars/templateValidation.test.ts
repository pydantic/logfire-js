import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  configureVariables,
  defineTemplateVar,
  defineVar,
  getVariableProvider,
  variablesClear,
  variablesPush,
  variablesValidate,
} from './index'
import type { VariablesConfig } from './index'
import { extractTemplatePaths } from './templateValidation'

const config = (variables: VariablesConfig['variables']): VariablesConfig => ({ variables })

describe('variable template validation', () => {
  beforeEach(() => {
    variablesClear()
    configureVariables(false)
  })

  afterEach(async () => {
    await getVariableProvider().shutdown?.()
    variablesClear()
    configureVariables(false)
  })

  it('extracts common Handlebars paths from templates', () => {
    expect(extractTemplatePaths('Hello {{user.name}} {{#if beta}}yes{{/if}}')).toEqual(['user.name', 'beta'])
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
    expect(report.templateInputWarnings).toEqual([
      {
        label: 'prod',
        message: "Template path 'missing' is not present in template_inputs_schema",
        path: 'missing',
        variableName: 'prompt',
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

    expect(report.templateInputWarnings).toMatchObject([{ path: 'unknown', variableName: 'prompt' }])
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

    expect(report.referenceWarnings).toEqual([
      {
        label: 'prod',
        message: "Variable 'prompt' references missing variable 'missing'",
        reference: 'missing',
        type: 'missing_reference',
        variableName: 'prompt',
      },
      {
        label: 'prod',
        message: 'VariableCompositionCycleError: Circular variable reference: cyclic -> cyclic',
        reference: 'cyclic',
        type: 'composition_cycle',
        variableName: 'cyclic',
      },
    ])
    expect(report.isValid).toBe(false)
  })

  it('strict push fails for reference and template validation warnings', async () => {
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

    await expect(variablesPush([prompt], { strict: true })).rejects.toThrow(
      'Cannot push variables: provider values are incompatible with local variable codecs, references, or template input schemas'
    )
  })
})
