import Handlebars from 'handlebars'

import { VariableRenderError } from './errors'

export function createSafeHandlebarsContext(value: unknown): unknown {
  if (typeof value === 'string') {
    return new Handlebars.SafeString(value)
  }
  if (Array.isArray(value)) {
    return value.map(createSafeHandlebarsContext)
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, createSafeHandlebarsContext(item)]))
  }
  return value
}

export function renderSerializedTemplate(serializedValue: string, inputs: Record<string, unknown> = {}): string {
  let value: unknown
  try {
    value = JSON.parse(serializedValue)
  } catch (error) {
    throw new VariableRenderError(`Failed to parse serialized template value: ${formatError(error)}`)
  }

  try {
    return JSON.stringify(renderTemplateValue(value, createSafeHandlebarsContext(inputs)))
  } catch (error) {
    if (error instanceof VariableRenderError) {
      throw error
    }
    throw new VariableRenderError(`Failed to render template: ${formatError(error)}`)
  }
}

function renderTemplateValue(value: unknown, context: unknown): unknown {
  if (typeof value === 'string') {
    if (!value.includes('{{')) {
      return value
    }
    return Handlebars.compile(value)(context)
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderTemplateValue(item, context))
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderTemplateValue(item, context)]))
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
