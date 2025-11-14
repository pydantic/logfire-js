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
  return Object.fromEntries(Object.entries(dict).filter(([, value]) => value !== undefined && value !== null)) as T
}
