import type { ScrubbedNote } from '.'
import { logfireApiConfig } from '.'
import { getOwn } from './ownRecord'
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

/** OTLP encodes every integral number attribute as a signed 64-bit `intValue`. */
const OTLP_MAX_INT = 9223372036854775807n
const OTLP_MIN_INT = -9223372036854775808n

const MAX_SCHEMA_DEPTH = 4
const MAX_OBJECT_PROPERTIES = 20
const MAX_ARRAY_ITEMS = 20
const UNSERIALIZABLE_VALUE = '[unserializable]'

export function serializeAttributes(attributes: RawAttributes): SerializedAttributes {
  const scrubber = logfireApiConfig.scrubber
  const alreadyScubbed = ATTRIBUTES_SPAN_TYPE_KEY in attributes
  const [scrubbedAttributes, scrubNotes] = alreadyScubbed ? [attributes, []] : scrubber.scrubValue([], attributes)

  // Built in Maps and materialized with `Object.fromEntries`, which defines own keys: attribute
  // keys are user data, and assigning a `__proto__` key to a plain record would run the inherited
  // setter and lose the attribute.
  const result = new Map<string, AttributeValue>()
  const nullArgs: string[] = []
  const schemaProperties = new Map<string, JSONSchema>()

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
      result.set(key, value as string[])
      continue
    }

    if (value === null || value === undefined) {
      nullArgs.push(key)
    } else if (typeof value === 'number') {
      result.set(key, serializeNumberAttribute(value))
    } else if (typeof value === 'string' || typeof value === 'boolean') {
      result.set(key, value)
    } else if (value instanceof Date) {
      try {
        result.set(key, value.toISOString())
        if (logfireApiConfig.jsonSchema === 'rich') {
          schemaProperties.set(key, { format: 'date-time', type: 'string' })
        }
      } catch {
        result.set(key, UNSERIALIZABLE_VALUE)
      }
    } else if (Array.isArray(value)) {
      serializeJsonAttribute(key, value, rawValue, 'array', result, schemaProperties)
    } else {
      serializeJsonAttribute(key, value, rawValue, 'object', result, schemaProperties)
    }
  }
  if (nullArgs.length > 0) {
    result.set(JSON_NULL_FIELDS_KEY, nullArgs)
  }
  if (schemaProperties.size > 0) {
    const schema: AttributesJSONSchema = { properties: Object.fromEntries(schemaProperties), type: 'object' }
    result.set(JSON_SCHEMA_KEY, JSON.stringify(schema))
  }
  return Object.fromEntries(result)
}

let warnedOversizedInteger = false

/**
 * A top-level number as OTLP can carry it. Two cases have no representation and are sent as
 * strings, which is what Python's `prepare_otlp_attribute` does:
 *
 * - `NaN` and `Infinity`: OTLP carries a double but JSON has no spelling for them, so they
 *   serialize to `null` and the value is lost. `String` spells them the way the message template
 *   already does, so the two agree.
 * - An integer outside signed 64-bit range: `otlp-transformer` encodes every integral number as an
 *   `intValue`, which a larger value overflows. `BigInt` prints the double's exact value, where
 *   `String` would give a rounded form such as `1e+21`.
 */
function serializeNumberAttribute(value: number): number | string {
  if (!Number.isFinite(value)) {
    return String(value)
  }
  if (!Number.isInteger(value)) {
    return value
  }
  const exact = BigInt(value)
  if (exact >= OTLP_MIN_INT && exact <= OTLP_MAX_INT) {
    return value
  }
  if (!warnedOversizedInteger) {
    warnedOversizedInteger = true
    console.warn(
      `Integer attribute ${exact.toString()} is outside the signed 64-bit range OTLP supports; sending it and any later oversized integer as a decimal string.`
    )
  }
  return exact.toString()
}

function serializeJsonAttribute(
  key: string,
  value: unknown,
  rawValue: unknown,
  basicType: 'array' | 'object',
  result: Map<string, AttributeValue>,
  schemaProperties: Map<string, JSONSchema>
): void {
  const serializedValue = stringifyJsonAttribute(value)
  if (serializedValue === undefined) {
    result.set(key, UNSERIALIZABLE_VALUE)
    return
  }

  result.set(key, serializedValue)

  if (logfireApiConfig.jsonSchema === false) {
    return
  }

  if (logfireApiConfig.jsonSchema === 'basic') {
    schemaProperties.set(key, { type: basicType })
    return
  }

  const inferredSchema = inferJsonSchema(value, {
    container: 'top-level',
    depth: 0,
    rawValue,
    seen: new WeakSet(),
  })
  if (inferredSchema !== undefined) {
    schemaProperties.set(key, inferredSchema)
  }
}

function stringifyJsonAttribute(value: unknown): string | undefined {
  try {
    // JSON writes NaN and Infinity as `null`, so a nested one is lost at any depth. Python's
    // encoder returns `str(o)` for a non-finite float wherever it appears, and
    // `serializeNumberAttribute` already sends the string for a top-level one.
    const serialized = JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'number' && !Number.isFinite(item) ? String(item) : item
    )
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
      // A nested non-finite number is sent as a string by `stringifyJsonAttribute`.
      return Number.isFinite(value) ? { type: 'number' } : { type: 'string' }
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
    const properties = new Map<string, JSONSchema>()
    const keys = Object.keys(value).sort().slice(0, MAX_OBJECT_PROPERTIES)

    for (const key of keys) {
      // `key` is own on `value` but not necessarily on `rawValue`, so an unguarded read there
      // could pick up an inherited member such as `constructor`.
      const propertySchema = inferJsonSchema(value[key], {
        container: 'object',
        depth: state.depth + 1,
        rawValue: getOwn(rawValue, key),
        seen: state.seen,
      })
      if (propertySchema !== undefined) {
        properties.set(key, propertySchema)
      }
    }

    return properties.size > 0 ? { properties: Object.fromEntries(properties), type: 'object' } : { type: 'object' }
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
