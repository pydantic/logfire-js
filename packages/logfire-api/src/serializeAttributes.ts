import { logfireApiConfig, ScrubbedNote } from '.'
import { ATTRIBUTES_SCRUBBED_KEY, ATTRIBUTES_SPAN_TYPE_KEY, ATTRIBUTES_TAGS_KEY, JSON_NULL_FIELDS_KEY, JSON_SCHEMA_KEY } from './constants'

export type AttributeValue = boolean | number | string | string[]

export type RawAttributes = Record<string, unknown>

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

export function serializeAttributes(attributes: RawAttributes): SerializedAttributes {
  const scrubber = logfireApiConfig.scrubber
  const alreadyScubbed = ATTRIBUTES_SPAN_TYPE_KEY in attributes
  const [scrubbedAttributes, scrubNotes] = alreadyScubbed ? [attributes, []] : scrubber.scrubValue([], attributes)

  const result: SerializedAttributes = {}
  const nullArgs: string[] = []
  const schema: JSONSchema = { properties: {}, type: 'object' }

  if (scrubNotes.length > 0) {
    if (ATTRIBUTES_SCRUBBED_KEY in scrubbedAttributes) {
      ;(scrubbedAttributes[ATTRIBUTES_SCRUBBED_KEY] as ScrubbedNote[]).push(...scrubNotes)
    } else {
      scrubbedAttributes[ATTRIBUTES_SCRUBBED_KEY] = scrubNotes
    }
  }
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
