/**
 * Per-case task-run context. Backed by `AsyncLocalStorage` on Node/Bun/Deno/Workers,
 * with a no-ALS fallback for the browser (which restricts offline evals to
 * `maxConcurrency = 1` since there's no way to keep concurrent runs from
 * cross-pollinating their attribute/metric maps).
 *
 * Mirrors pydantic-evals' `CURRENT_TASK_RUN` ContextVar.
 */

import type { AsyncLocalStorage } from 'node:async_hooks'

import type { TaskRunState } from './types'

import { hasAsyncLocalStorage } from './runtime'

interface ALSLike<T> {
  getStore(): T | undefined
  run<R>(store: T, callback: () => R): R
}

let alsImpl: ALSLike<TaskRunState> | null = null
let alsProbeComplete = false
/** Fallback storage cell for runtimes without ALS. Single-slot, single-execute. */
let fallbackStore: null | TaskRunState = null

async function ensureALS(): Promise<void> {
  if (alsImpl !== null) {
    return
  }
  if (alsProbeComplete) {
    return
  }
  alsProbeComplete = true
  if (!hasAsyncLocalStorage()) {
    return
  }
  // Lazy import — `node:async_hooks` is not available on the browser. Vite is
  // configured to externalize `node:*` so this resolves at runtime against the
  // host's module resolver.
  try {
    const mod: { AsyncLocalStorage: typeof AsyncLocalStorage } = await import('node:async_hooks')
    alsImpl = new mod.AsyncLocalStorage<TaskRunState>()
  } catch {
    alsImpl = null
  }
}

/** Run `fn` with `state` set as the current task-run context. */
export async function runWithTaskRun<R>(state: TaskRunState, fn: () => Promise<R> | R): Promise<R> {
  if (alsImpl === null) {
    await ensureALS()
  }
  if (alsImpl !== null) {
    return alsImpl.run(state, fn)
  }
  // No ALS available — single-slot fallback. Concurrent calls will clobber each
  // other; document `maxConcurrency = 1` for browser users.
  const previous = fallbackStore
  fallbackStore = state
  try {
    return await fn()
  } finally {
    fallbackStore = previous
  }
}

export function getCurrentTaskRun(): TaskRunState | undefined {
  if (alsImpl !== null) {
    return alsImpl.getStore()
  }
  return fallbackStore ?? undefined
}

/**
 * Record an attribute on the current case's span. No-op outside a `Dataset.evaluate`
 * task. Mirrors pydantic-evals' `set_eval_attribute`.
 */
export function setEvalAttribute(name: string, value: unknown): void {
  const state = getCurrentTaskRun()
  if (state === undefined) {
    return
  }
  setOwn(state.attributes, name, value)
}

/**
 * Add `amount` to a metric, leaving the key absent when the result is still zero.
 *
 * Mirrors pydantic-evals' `TaskRun.increment_metric`, which is the single place that
 * writes metrics in the Python port and skips the write when both the current and the
 * new value are zero. Every metric write here must go through this so a zero-valued
 * usage attribute does not invent a metric key that Python omits.
 */
export function incrementMetric(metrics: Record<string, number>, name: string, amount: number): void {
  const current = Object.hasOwn(metrics, name) ? (metrics[name] ?? 0) : 0
  const next = current + amount
  if (current === 0 && next === 0) {
    return
  }
  setOwn(metrics, name, next)
}

/**
 * Write an own property, for records whose keys are not the SDK's to choose. Metric names are
 * sliced off span attribute keys in `extractMetrics`, so they arrive from the provider's usage
 * payload, and attribute names come from task code. Plain assignment reaches the prototype: a
 * `__proto__` name invokes the inherited setter and the entry is dropped, and a name like
 * `toString` reads back the inherited function.
 */
function setOwn<T>(record: Record<string, T>, name: string, value: T): void {
  Object.defineProperty(record, name, { configurable: true, enumerable: true, value, writable: true })
}

/**
 * Increment a metric on the current case. No-op outside a `Dataset.evaluate`
 * task. Mirrors pydantic-evals' `increment_eval_metric`.
 */
export function incrementEvalMetric(name: string, amount: number): void {
  const state = getCurrentTaskRun()
  if (state === undefined) {
    return
  }
  incrementMetric(state.metrics, name, amount)
}
