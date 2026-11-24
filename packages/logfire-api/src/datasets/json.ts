import type { EvaluationDatasetValueContext, EvaluationDatasetValueSerializer } from './evaluation'

export class DatasetSerializationError extends Error {
  override name = 'DatasetSerializationError'
}

export function normalizeHostedJsonValue(
  value: unknown,
  context: EvaluationDatasetValueContext,
  serializeValue: EvaluationDatasetValueSerializer | undefined
): unknown {
  return normalizeValue(value, context, serializeValue, new WeakSet(), new Set())
}

export interface CaseJsonValueContext {
  field: 'expectedOutput' | 'inputs' | 'metadata'
  method: 'addCases' | 'updateCase'
  path: string
}

/**
 * Reject the case field values a plain `JSON.stringify` body would change without an error
 * (Maps, Sets, non-finite numbers, bigints, symbols, functions and circular references) by
 * throwing a `DatasetSerializationError` naming the field and path. Unlike
 * `normalizeHostedJsonValue`, `undefined` and class instances keep working, so calls that
 * succeed today still succeed.
 */
export function assertCaseJsonValue(value: unknown, context: CaseJsonValueContext): void {
  checkCaseJsonValue(value, context, new WeakSet())
}

function checkCaseJsonValue(value: unknown, context: CaseJsonValueContext, ancestors: WeakSet<object>): void {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') {
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new DatasetSerializationError(`${formatCaseContext(context)} contains unsupported non-finite number value`)
    }
    return
  }
  if (typeof value !== 'object' || value instanceof Map || value instanceof Set) {
    throw new DatasetSerializationError(`${formatCaseContext(context)} contains unsupported ${describeUnsupportedValue(value)}`)
  }
  if (ancestors.has(value)) {
    throw new DatasetSerializationError(`${formatCaseContext(context)} contains a circular ${Array.isArray(value) ? 'array' : 'object'}`)
  }
  // A `toJSON` method wins over own properties in JSON.stringify, so a value that defines one
  // serializes through it alone and there is nothing reliable to check inside.
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        checkCaseJsonValue(item, { ...context, path: `${context.path}[${index.toString()}]` }, ancestors)
      })
    } else {
      for (const [key, item] of Object.entries(value)) {
        checkCaseJsonValue(item, { ...context, path: objectPath(context.path, key) }, ancestors)
      }
    }
  } finally {
    ancestors.delete(value)
  }
}

function formatCaseContext(context: CaseJsonValueContext): string {
  return `${context.method} ${context.field} at ${context.path}`
}

function normalizeValue(
  value: unknown,
  context: EvaluationDatasetValueContext,
  serializeValue: EvaluationDatasetValueSerializer | undefined,
  ancestors: WeakSet<object>,
  serializedValues: Set<unknown>
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
    if (Number.isNaN(value.getTime())) {
      return normalizeUnsupportedValue(value, context, serializeValue, ancestors, serializedValues, 'invalid Dates')
    }
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
      // Assigning into a plain object would invoke the `__proto__` setter rather than create an
      // own property, so a JSON-parsed value carrying an own `__proto__` key would lose it here
      // without any error. `Object.fromEntries` defines own properties, as `vars/template.ts`
      // already does for the same reason.
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          normalizeValue(item, { ...context, path: objectPath(context.path, key) }, serializeValue, ancestors, serializedValues),
        ])
      )
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
  serializedValues: Set<unknown>,
  reason: string
): unknown {
  if (serializeValue === undefined) {
    throw new DatasetSerializationError(`${formatContext(context)} contains unsupported ${reason}; pass serializeValue to convert it`)
  }
  if (serializedValues.has(value)) {
    throw new DatasetSerializationError(`${formatContext(context)} serializeValue returned the same unsupported ${reason}`)
  }
  serializedValues.add(value)
  try {
    const serialized = serializeValue(value, context)
    if (serialized === undefined) {
      throw new DatasetSerializationError(`${formatContext(context)} contains unsupported ${reason}; serializeValue did not convert it`)
    }
    return normalizeValue(serialized, context, serializeValue, ancestors, serializedValues)
  } finally {
    serializedValues.delete(value)
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
