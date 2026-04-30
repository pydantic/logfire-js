/**
 * Runtime detection. Used to pick a strategy for ALS, file IO, and other
 * runtime-specific affordances.
 */
export type RuntimeName = 'browser' | 'bun' | 'deno' | 'node' | 'workers'

interface MaybeProcess {
  process?: { versions?: { node?: string } }
}
interface MaybeBun {
  Bun?: unknown
}
interface MaybeDeno {
  Deno?: { readTextFile?: unknown; writeTextFile?: unknown }
}
interface MaybeWorkers {
  caches?: unknown
  navigator?: { userAgent?: string }
  WebSocketPair?: unknown
}

export function detectRuntime(): RuntimeName {
  const g = globalThis as MaybeBun & MaybeDeno & MaybeProcess & MaybeWorkers
  if (g.Bun !== undefined) return 'bun'
  if (g.Deno !== undefined && typeof g.Deno.readTextFile === 'function') return 'deno'
  if (g.process?.versions?.node !== undefined) return 'node'
  // CF Workers expose a navigator.userAgent of 'Cloudflare-Workers' and have
  // no `process`. This must come before the generic browser check.
  if (typeof g.navigator?.userAgent === 'string' && g.navigator.userAgent.toLowerCase().includes('cloudflare')) {
    return 'workers'
  }
  return 'browser'
}

/** True for runtimes where `node:async_hooks` (and thus `AsyncLocalStorage`) is available. */
export function hasAsyncLocalStorage(): boolean {
  const r = detectRuntime()
  return r === 'node' || r === 'bun' || r === 'deno' || r === 'workers'
}

/** True for runtimes where `node:fs/promises` is usable. */
export function hasNodeFs(): boolean {
  const r = detectRuntime()
  return r === 'node' || r === 'bun' || r === 'deno'
}
