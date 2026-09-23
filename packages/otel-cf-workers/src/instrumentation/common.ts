import type { SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { passthroughGet, wrap } from '../wrap.js'

type ContextAndTracker = { ctx: ExecutionContext; tracker: PromiseTracker }
type WaitUntilFn = ExecutionContext['waitUntil']

export class PromiseTracker {
  outstandingPromises: Promise<unknown>[] = []

  get outstandingPromiseCount(): number {
    return this.outstandingPromises.length
  }

  track(promise: Promise<unknown>): void {
    this.outstandingPromises.push(promise)
  }

  async wait(): Promise<void> {
    await allSettledMutable(this.outstandingPromises)
  }
}

function createWaitUntil(fn: WaitUntilFn, context: ExecutionContext, tracker: PromiseTracker): WaitUntilFn {
  const handler: ProxyHandler<WaitUntilFn> = {
    apply(target, _thisArg, argArray) {
      tracker.track(argArray[0])
      return Reflect.apply(target, context, argArray)
    },
  }
  return wrap(fn, handler)
}

export function proxyExecutionContext(context: ExecutionContext): ContextAndTracker {
  const tracker = new PromiseTracker()
  const ctx = new Proxy(context, {
    get(target, prop) {
      if (prop === 'waitUntil') {
        const fn = Reflect.get(target, prop)
        return createWaitUntil(fn, context, tracker)
      } else {
        return passthroughGet(target, prop)
      }
    },
  })
  return { ctx, tracker }
}

/**
 * Runs after the handler's context has been exited, so the config's span processors must be
 * passed in explicitly rather than read from the active context.
 */
export async function exportSpans(spanProcessors: SpanProcessor[], tracker?: PromiseTracker): Promise<void> {
  await scheduler.wait(1)
  if (tracker) {
    await tracker.wait()
  }
  const promises = spanProcessors.map(async (spanProcessor) => {
    await spanProcessor.forceFlush()
  })
  await Promise.allSettled(promises)
}

/** Like `Promise.allSettled`, but handles modifications to the promises array */
async function allSettledMutable(promises: Promise<unknown>[]): Promise<PromiseSettledResult<unknown>[]> {
  let values: PromiseSettledResult<unknown>[]
  // when the length of the array changes, there has been a nested call to waitUntil
  // and we should await the promises again
  do {
    // eslint-disable-next-line no-await-in-loop
    values = await Promise.allSettled(promises)
  } while (values.length !== promises.length)
  return values
}

/** Overloads extracts up to 4 overloads for the given function. */
export type Overloads<T> = T extends {
  (...args: infer P1): infer R1
  (...args: infer P2): infer R2
  (...args: infer P3): infer R3
  (...args: infer P4): infer R4
}
  ? ((...args: P1) => R1) | ((...args: P2) => R2) | ((...args: P3) => R3) | ((...args: P4) => R4)
  : never
