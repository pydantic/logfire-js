import type { ScrubbedNote } from '.'
import { logfireApiConfig } from '.'
import { ATTRIBUTES_SCRUBBED_KEY, ATTRIBUTES_SPAN_TYPE_KEY, ATTRIBUTES_TAGS_KEY, JSON_NULL_FIELDS_KEY, JSON_SCHEMA_KEY } from './constants'

export type AttributeValue = boolean | number | string | string[]

export type RawAttributes = Record<string, unknown>

type JSONSchema =
  | { items?: JSONSchema; type: 'array' }
  | { properties?: Record<string, JSONSchema>; type: 'object' }
  | { format?: 'date-time'; type: 'string' }
  | { type: 'boolean' }
  | { type: 'null' }
  | { type: 'number' }

interface AttributesJSONSchema {
  properties: Record<string, JSONSchema>
  type: 'object'
}

type SerializedAttributes = Record<string, AttributeValue>
type ContainerKind = 'array' | 'object' | 'top-level'

const MAX_SCHEMA_DEPTH = 4
const MAX_OBJECT_PROPERTIES = 20
const MAX_ARRAY_ITEMS = 20
const UNSERIALIZABLE_VALUE = '[unserializable]'

export function serializeAttributes(attributes: RawAttributes): SerializedAttributes {
  const scrubber = logfireApiConfig.scrubber
  const alreadyScubbed = ATTRIBUTES_SPAN_TYPE_KEY in attributes
  const [scrubbedAttributes, scrubNotes] = alreadyScubbed ? [attributes, []] : scrubber.scrubValue([], attributes)

  const result: SerializedAttributes = {}
  const nullArgs: string[] = []
  const schema: AttributesJSONSchema = { properties: {}, type: 'object' }

  if (scrubNotes.length > 0) {
    if (ATTRIBUTES_SCRUBBED_KEY in scrubbedAttributes) {
      ;(scrubbedAttributes[ATTRIBUTES_SCRUBBED_KEY] as ScrubbedNote[]).push(...scrubNotes)
    } else {
      scrubbedAttributes[ATTRIBUTES_SCRUBBED_KEY] = scrubNotes
    }
  }
  for (const [key, value] of Object.entries(scrubbedAttributes)) {
    const rawValue = Object.hasOwn(attributes, key) ? attributes[key] : value
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
      try {
        result[key] = value.toISOString()
        if (logfireApiConfig.jsonSchema === 'rich') {
          schema.properties[key] = { format: 'date-time', type: 'string' }
        }
      } catch {
        result[key] = UNSERIALIZABLE_VALUE
      }
    } else if (Array.isArray(value)) {
      serializeJsonAttribute(key, value, rawValue, 'array', result, schema)
    } else {
      serializeJsonAttribute(key, value, rawValue, 'object', result, schema)
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

function serializeJsonAttribute(
  key: string,
  value: unknown,
  rawValue: unknown,
  basicType: 'array' | 'object',
  result: SerializedAttributes,
  schema: AttributesJSONSchema
): void {
  const serializedValue = stringifyJsonAttribute(value)
  if (serializedValue === undefined) {
    result[key] = UNSERIALIZABLE_VALUE
    return
  }

  result[key] = serializedValue

  if (logfireApiConfig.jsonSchema === false) {
    return
  }

  if (logfireApiConfig.jsonSchema === 'basic') {
    schema.properties[key] = { type: basicType }
    return
  }

  const inferredSchema = inferJsonSchema(value, {
    container: 'top-level',
    depth: 0,
    rawValue,
    seen: new WeakSet(),
  })
  if (inferredSchema !== undefined) {
    schema.properties[key] = inferredSchema
  }
}

function stringifyJsonAttribute(value: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string' ? serialized : undefined
  } catch {
    return undefined
  }
}

function inferJsonSchema(
  value: unknown,
  state: {
    container: ContainerKind
    depth: number
    rawValue: unknown
    seen: WeakSet<object>
  }
): JSONSchema | undefined {
  const rawValue = state.rawValue

  if (value === null) {
    return { type: 'null' }
  }
  if (value === undefined) {
    return state.container === 'array' ? { type: 'null' } : undefined
  }

  switch (typeof value) {
    case 'boolean':
      return { type: 'boolean' }
    case 'number':
      return Number.isFinite(value) ? { type: 'number' } : { type: 'null' }
    case 'string':
      return { type: 'string' }
    case 'bigint':
      return undefined
    case 'function':
    case 'symbol':
      return state.container === 'array' ? { type: 'null' } : undefined
    case 'object':
      break
    case 'undefined':
      return state.container === 'array' ? { type: 'null' } : undefined
    default:
      return undefined
  }

  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? { format: 'date-time', type: 'string' } : { type: 'null' }
  }

  if (Array.isArray(value)) {
    return inferArraySchema(value, Array.isArray(rawValue) ? rawValue : value, state)
  }

  if (
    rawValue !== null &&
    typeof rawValue === 'object' &&
    !Array.isArray(rawValue) &&
    !(rawValue instanceof Date) &&
    !isPlainObject(rawValue)
  ) {
    return { type: 'object' }
  }

  if (!isPlainObject(value)) {
    return { type: 'object' }
  }

  const rawObjectValue = rawValue !== null && typeof rawValue === 'object' && isPlainObject(rawValue) ? rawValue : value
  return inferObjectSchema(value, rawObjectValue, state)
}

function inferArraySchema(
  value: unknown[],
  rawValue: unknown[],
  state: {
    depth: number
    seen: WeakSet<object>
  }
): JSONSchema {
  if (state.depth >= MAX_SCHEMA_DEPTH || state.seen.has(value)) {
    return { type: 'array' }
  }

  state.seen.add(value)
  try {
    if (value.length === 0) {
      return { type: 'array' }
    }

    const itemSchemas: JSONSchema[] = []
    for (let index = 0; index < Math.min(value.length, MAX_ARRAY_ITEMS); index++) {
      const itemSchema = inferJsonSchema(value[index], {
        container: 'array',
        depth: state.depth + 1,
        rawValue: rawValue[index],
        seen: state.seen,
      })
      if (itemSchema !== undefined) {
        itemSchemas.push(itemSchema)
      }
    }

    if (itemSchemas.length === 0 || !schemasAreHomogeneous(itemSchemas)) {
      return { type: 'array' }
    }

    const itemSchema = itemSchemas[0]
    if (itemSchema === undefined || isBroadContainerSchema(itemSchema)) {
      return { type: 'array' }
    }

    return { items: itemSchema, type: 'array' }
  } finally {
    state.seen.delete(value)
  }
}

function inferObjectSchema(
  value: Record<string, unknown>,
  rawValue: Record<string, unknown>,
  state: {
    depth: number
    seen: WeakSet<object>
  }
): JSONSchema {
  if (state.depth >= MAX_SCHEMA_DEPTH || state.seen.has(value)) {
    return { type: 'object' }
  }

  state.seen.add(value)
  try {
    const properties: Record<string, JSONSchema> = {}
    const keys = Object.keys(value).sort().slice(0, MAX_OBJECT_PROPERTIES)

    for (const key of keys) {
      const propertySchema = inferJsonSchema(value[key], {
        container: 'object',
        depth: state.depth + 1,
        rawValue: rawValue[key],
        seen: state.seen,
      })
      if (propertySchema !== undefined) {
        properties[key] = propertySchema
      }
    }

    return Object.keys(properties).length > 0 ? { properties, type: 'object' } : { type: 'object' }
  } finally {
    state.seen.delete(value)
  }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

function schemasAreHomogeneous(schemas: JSONSchema[]): boolean {
  const firstSchema = stringifyStableSchema(schemas[0])
  return schemas.every((schema) => stringifyStableSchema(schema) === firstSchema)
}

function stringifyStableSchema(schema: JSONSchema | undefined): string {
  return JSON.stringify(schema)
}

function isBroadContainerSchema(schema: JSONSchema): boolean {
  if (schema.type === 'object') {
    return schema.properties === undefined
  }
  if (schema.type === 'array') {
    return schema.items === undefined
  }
  return false
}
