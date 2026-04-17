export class PydanticEvalsDeprecationWarning {
  readonly message: string
  readonly name = 'PydanticEvalsDeprecationWarning'

  constructor(message: string) {
    this.message = message
  }
}

export const UNSET: unique symbol = Symbol('UNSET')

export type Unset = typeof UNSET

export function isSet<T>(value: T | Unset): value is T {
  return value !== UNSET
}

export function getFunctionName(fn: (...args: never[]) => unknown): string {
  const name = fn.name
  if (name && name !== 'anonymous') {
    return name
  }
  return 'anonymous'
}

export async function taskGroupGather<T>(tasks: (() => Promise<T>)[]): Promise<T[]> {
  return Promise.all(tasks.map((t) => t()))
}

export async function taskGroupGatherConcurrency<T>(tasks: (() => Promise<T>)[], maxConcurrency: null | number): Promise<T[]> {
  if (maxConcurrency === null || maxConcurrency >= tasks.length) {
    return taskGroupGather(tasks)
  }
  const results: T[] = new Array<T>(tasks.length)
  let idx = 0
  const workers: Promise<void>[] = []
  for (let w = 0; w < maxConcurrency; w++) {
    workers.push(
      (async () => {
        while (true) {
          const current = idx++
          if (current >= tasks.length) return
          results[current] = await tasks[current]!()
        }
      })()
    )
  }
  await Promise.all(workers)
  return results
}

const warned = new Set<string>()

export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return
  warned.add(key)
  try {
    /* v8 ignore next 6 - process.emitWarning is always available in Node test env */
    if (typeof process !== 'undefined' && typeof process.emitWarning === 'function') {
      process.emitWarning(message, 'PydanticEvalsDeprecationWarning')
    } else {
      console.warn(`PydanticEvalsDeprecationWarning: ${message}`)
    }
  } catch {
    console.warn(`PydanticEvalsDeprecationWarning: ${message}`)
  }
}
