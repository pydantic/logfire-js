import type { EvaluationDatasetValueContext, EvaluationDatasetValueSerializer } from './evaluation'

export class DatasetSerializationError extends Error {
  override name = 'DatasetSerializationError'
}

export function normalizeHostedJsonValue(
  value: unknown,
  context: EvaluationDatasetValueContext,
  serializeValue: EvaluationDatasetValueSerializer | undefined
): unknown {
  return normalizeValue(value, context, serializeValue, new WeakSet(), new WeakSet())
}

function normalizeValue(
  value: unknown,
  context: EvaluationDatasetValueContext,
  serializeValue: EvaluationDatasetValueSerializer | undefined,
  ancestors: WeakSet<object>,
  serializedValues: WeakSet<object>
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) {
      return value
    }
    return normalizeUnsupportedValue(value, context, serializeValue, ancestors, serializedValues, 'non-finite numbers')
  }
  if (value instanceof Date) {
    return value.toISOString()
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new DatasetSerializationError(`${formatContext(context)} contains a circular array`)
    }
    ancestors.add(value)
    try {
      return value.map((item, index) =>
        normalizeValue(item, { ...context, path: `${context.path}[${index.toString()}]` }, serializeValue, ancestors, serializedValues)
      )
    } finally {
      ancestors.delete(value)
    }
  }
  if (isPlainObject(value)) {
    if (ancestors.has(value)) {
      throw new DatasetSerializationError(`${formatContext(context)} contains a circular object`)
    }
    ancestors.add(value)
    try {
      const result: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value)) {
        result[key] = normalizeValue(item, { ...context, path: objectPath(context.path, key) }, serializeValue, ancestors, serializedValues)
      }
      return result
    } finally {
      ancestors.delete(value)
    }
  }
  return normalizeUnsupportedValue(value, context, serializeValue, ancestors, serializedValues, describeUnsupportedValue(value))
}

function normalizeUnsupportedValue(
  value: unknown,
  context: EvaluationDatasetValueContext,
  serializeValue: EvaluationDatasetValueSerializer | undefined,
  ancestors: WeakSet<object>,
  serializedValues: WeakSet<object>,
  reason: string
): unknown {
  if (serializeValue === undefined) {
    throw new DatasetSerializationError(`${formatContext(context)} contains unsupported ${reason}; pass serializeValue to convert it`)
  }
  const tracked = typeof value === 'object' && value !== null
  if (tracked) {
    if (serializedValues.has(value)) {
      throw new DatasetSerializationError(`${formatContext(context)} serializeValue returned the same unsupported ${reason}`)
    }
    serializedValues.add(value)
  }
  try {
    const serialized = serializeValue(value, context)
    if (serialized === undefined) {
      throw new DatasetSerializationError(`${formatContext(context)} contains unsupported ${reason}; serializeValue did not convert it`)
    }
    return normalizeValue(serialized, context, serializeValue, ancestors, serializedValues)
  } finally {
    if (tracked) {
      serializedValues.delete(value)
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function describeUnsupportedValue(value: unknown): string {
  switch (typeof value) {
    case 'bigint':
      return 'bigint value'
    case 'function':
      return 'function value'
    case 'symbol':
      return 'symbol value'
    case 'undefined':
      return 'undefined value'
    case 'boolean':
      return 'boolean value'
    case 'number':
      return 'number value'
    case 'string':
      return 'string value'
    case 'object':
      if (value instanceof Map) {
        return 'Map value'
      }
      if (value instanceof Set) {
        return 'Set value'
      }
      return `${objectTypeName(value)} instance`
    default:
      return `${typeof value} value`
  }
}

function objectTypeName(value: object | null): string {
  if (value === null) {
    return 'null'
  }
  const constructor = (value as { constructor?: { name?: unknown } }).constructor
  const name = constructor?.name
  return typeof name === 'string' && name !== '' ? name : 'object'
}

function objectPath(base: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/u.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`
}

function formatContext(context: EvaluationDatasetValueContext): string {
  const caseLabel =
    context.caseName !== undefined
      ? ` for case ${JSON.stringify(context.caseName)}`
      : context.caseIndex !== undefined
        ? ` for case index ${context.caseIndex.toString()}`
        : ''
  return `pushEvaluationDataset ${context.field}${caseLabel} at ${context.path}`
}
