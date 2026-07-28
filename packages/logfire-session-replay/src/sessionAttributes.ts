import type { SessionAttributeValue, SessionAttributes, SessionAttributesInput } from './types'

const MAX_SESSION_ATTRIBUTES = 20
const MAX_SESSION_ATTRIBUTE_STRING_CODE_POINTS = 200
const SESSION_ATTRIBUTE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u

function hasAtMostCodePoints(value: string, maximum: number): boolean {
  let count = 0
  for (const codePoint of value) {
    count += codePoint.length > 0 ? 1 : 0
    if (count > maximum) {
      return false
    }
  }
  return true
}

export function snapshotSessionAttributes(
  getSessionAttributes: (() => SessionAttributesInput) | undefined,
  reportError: (error: unknown) => void
): SessionAttributes {
  if (getSessionAttributes === undefined) {
    return Object.freeze({})
  }

  let value: unknown
  try {
    value = getSessionAttributes()
  } catch (error) {
    reportError(error)
    return Object.freeze({})
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return Object.freeze({})
  }

  let prototype: object | null
  try {
    prototype = Object.getPrototypeOf(value) as object | null
  } catch (error) {
    reportError(error)
    return Object.freeze({})
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return Object.freeze({})
  }

  let keys: string[]
  try {
    keys = Object.keys(value)
  } catch (error) {
    reportError(error)
    return Object.freeze({})
  }

  const attributes: SessionAttributes = {}
  let accepted = 0
  for (const key of keys) {
    if (!SESSION_ATTRIBUTE_KEY_PATTERN.test(key)) {
      continue
    }

    let attributeValue: unknown
    try {
      attributeValue = Reflect.get(value, key)
    } catch (error) {
      reportError(error)
      continue
    }

    const valid =
      typeof attributeValue === 'boolean' ||
      (typeof attributeValue === 'number' && Number.isFinite(attributeValue)) ||
      (typeof attributeValue === 'string' && hasAtMostCodePoints(attributeValue, MAX_SESSION_ATTRIBUTE_STRING_CODE_POINTS))
    if (!valid) {
      continue
    }

    attributes[key] = attributeValue as SessionAttributeValue
    accepted += 1
    if (accepted === MAX_SESSION_ATTRIBUTES) {
      break
    }
  }

  return Object.freeze(attributes)
}
