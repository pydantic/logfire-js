/**
 * Creates a new object by excluding specified keys from the original object
 * @param obj The source object
 * @param keys Array of keys to exclude from the result
 * @returns A new object without the specified keys
 */
export function omit<T extends object, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> {
  const keysToExclude = new Set(keys)
  return Object.fromEntries(Object.entries(obj).filter(([key]) => !keysToExclude.has(key as K))) as Omit<T, K>
}

export function removeEmptyKeys<T extends Record<string, unknown>>(dict: T): T {
  // An empty string is as absent as null here: the Python SDK guards each of these resource
  // fields with `if self.environment:` and friends, so a blank value has to leave the attribute
  // off rather than stamp an empty one on every span.
  return Object.fromEntries(Object.entries(dict).filter(([, value]) => value !== undefined && value !== null && value !== '')) as T
}
