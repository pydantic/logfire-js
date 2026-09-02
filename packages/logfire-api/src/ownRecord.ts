/**
 * Own-property access for plain-object records whose keys are not the SDK's to choose.
 *
 * Plain assignment and property reads reach the prototype: writing a `__proto__` key runs the
 * inherited setter and the entry is silently dropped, and reading an absent `toString` key finds
 * the inherited function. Records that are only built up internally should use a `Map` and
 * convert at the edge with `Object.fromEntries`, which defines own keys; these helpers are for
 * records that must stay plain objects because they are exposed as mutable public API.
 */

export function setOwn<T>(record: Record<string, T>, name: string, value: T): void {
  Object.defineProperty(record, name, { configurable: true, enumerable: true, value, writable: true })
}

export function getOwn<T>(record: Record<string, T>, name: string): T | undefined {
  return Object.hasOwn(record, name) ? record[name] : undefined
}
