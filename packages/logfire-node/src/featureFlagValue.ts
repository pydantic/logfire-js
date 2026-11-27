export function cloneSchemaOutput<T>(value: T): T {
  return cloneJson(value, new WeakSet()) as T
}

function cloneJson(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
    return value
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    throw new TypeError('Feature flag schemas must return JSON values')
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) {
    throw new TypeError('Feature flag schemas must return JSON values')
  }
  ancestors.add(value)
  try {
    return Array.isArray(value)
      ? Array.from(value, (item: unknown) => cloneJson(item, ancestors))
      : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item, ancestors)]))
  } finally {
    ancestors.delete(value)
  }
}
