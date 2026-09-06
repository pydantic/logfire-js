/**
 * Own-property writes for plain-object records whose keys are not the SDK's to choose, the same
 * convention as `ownRecord.ts` in the core `logfire` package (which does not export it — these
 * helpers are an implementation detail, not API). A plain assignment to a `__proto__` key runs
 * the inherited setter: a primitive value is silently dropped, an object value replaces the
 * record's prototype.
 */
export function setOwn<T>(record: Record<string, T>, name: string, value: T): void {
  Object.defineProperty(record, name, { configurable: true, enumerable: true, value, writable: true })
}
