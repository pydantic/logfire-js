/**
 * Per-case task-run context. Backed by `AsyncLocalStorage` on Node/Bun/Deno/Workers,
 * with a no-ALS fallback for the browser (which restricts offline evals to
 * `maxConcurrency = 1` since there's no way to keep concurrent runs from
 * cross-pollinating their attribute/metric maps).
 *
 * Mirrors pydantic-evals' `CURRENT_TASK_RUN` ContextVar.
 */

import type { TaskRunState } from './types'

import { hasAsyncLocalStorage } from './runtime'

interface ALSLike<T> {
  getStore(): T | undefined
  run<R>(store: T, callback: () => R): R
}

let alsImpl: ALSLike<TaskRunState> | null = null
/** Fallback storage cell for runtimes without ALS. Single-slot, single-execute. */
let fallbackStore: null | TaskRunState = null

async function ensureALS(): Promise<void> {
  if (alsImpl !== null) return
  if (!hasAsyncLocalStorage()) return
  // Lazy import — `node:async_hooks` is not available on the browser. Vite is
  // configured to externalize `node:*` so this resolves at runtime against the
  // host's module resolver.
  const mod: typeof import('node:async_hooks') = await import('node:async_hooks')
  alsImpl = new mod.AsyncLocalStorage<TaskRunState>()
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
  if (state === undefined) return
  state.attributes[name] = value
}

/**
 * Increment a metric on the current case. No-op outside a `Dataset.evaluate`
 * task. Mirrors pydantic-evals' `increment_eval_metric`.
 */
export function incrementEvalMetric(name: string, amount: number): void {
  const state = getCurrentTaskRun()
  if (state === undefined) return
  state.metrics[name] = (state.metrics[name] ?? 0) + amount
}
