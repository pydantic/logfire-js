import { ATTRIBUTES_TAGS_KEY } from '.'
import { AttributeScrubber } from './AttributeScrubber'

export type AttributeValue = boolean | number | string | string[]

export type RawAttributes = Record<string, unknown>

const JSON_SCHEMA_KEY = 'logfire.json_schema'
const JSON_NULL_FIELDS_KEY = 'logfire.null_args'

interface JSONSchema {
  properties: Record<
    string,
    {
      type: 'array' | 'object'
    }
  >
  type: 'object'
}

type SerializedAttributes = Record<string, AttributeValue>

export function serializeAttributes(attributes: RawAttributes, scrubber: AttributeScrubber): SerializedAttributes {
  const scrubbedAttributes = scrubber.scrubValue([], attributes)[0] as Record<string, unknown>

  const result: SerializedAttributes = {}
  const nullArgs: string[] = []
  const schema: JSONSchema = { properties: {}, type: 'object' }
  for (const [key, value] of Object.entries(scrubbedAttributes)) {
    // we don't want to serialize the tags
    if (key === ATTRIBUTES_TAGS_KEY) {
      result[key] = value as string[]
      continue
    }

    if (value === null || value === undefined) {
      nullArgs.push(key)
    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value
    } else if (value instanceof Date) {
      result[key] = value.toISOString()
    } else if (Array.isArray(value)) {
      schema.properties[key] = {
        type: 'array',
      }
      result[key] = JSON.stringify(value)
    } else {
      schema.properties[key] = {
        type: 'object',
      }

      result[key] = JSON.stringify(value)
    }
  }
  if (nullArgs.length > 0) {
    result[JSON_NULL_FIELDS_KEY] = nullArgs
  }
  if (Object.keys(schema.properties).length > 0) {
    result[JSON_SCHEMA_KEY] = JSON.stringify(schema)
  }
  return result
}
