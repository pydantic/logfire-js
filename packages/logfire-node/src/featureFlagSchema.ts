import type { JsonSchema } from 'logfire/vars'

const schemaMaps = new Set(['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas', 'dependencies'])
const schemaLists = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])
const subschemas = new Set([
  'additionalItems',
  'additionalProperties',
  'contains',
  'contentSchema',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
])
const privateAnnotations = new Set(['default', 'example', 'examples'])
const maxSchemaBytes = 16_384

export function schemaForDiscovery(schema: JsonSchema | undefined): string | undefined {
  if (schema === undefined) {
    return undefined
  }
  try {
    const serialized = JSON.stringify(stripSchemaAnnotations(schema))
    return new TextEncoder().encode(serialized).length <= maxSchemaBytes ? serialized : undefined
  } catch {
    // A schema that cannot be serialized should not prevent evaluating the flag.
    return undefined
  }
}

function stripSchemaAnnotations(schema: unknown): unknown {
  if (!isRecord(schema)) {
    return schema
  }

  // Only traverse subschema positions. Property names and literal validation
  // values can contain the same keys as schema annotations.
  const entries: [string, unknown][] = []
  for (const [key, value] of Object.entries(schema)) {
    if (privateAnnotations.has(key)) {
      continue
    }
    if (schemaMaps.has(key) && isRecord(value)) {
      entries.push([key, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, stripSchemaAnnotations(child)]))])
    } else if ((schemaLists.has(key) || key === 'items') && Array.isArray(value)) {
      entries.push([key, value.map(stripSchemaAnnotations)])
    } else {
      entries.push([key, subschemas.has(key) ? stripSchemaAnnotations(value) : value])
    }
  }
  return Object.fromEntries(entries)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
