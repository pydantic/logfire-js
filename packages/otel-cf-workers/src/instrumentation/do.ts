import type { Exception, SpanOptions } from '@opentelemetry/api'
import { context as api_context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import type { Initialiser } from '../config.js'
import { getActiveConfig, setConfig } from '../config.js'
import { ATTR_FAAS_COLDSTART, ATTR_FAAS_TRIGGER } from '../semconv.js'
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base'
import type { DOConstructorTrigger, ResolvedTraceConfig } from '../types.js'
import { passthroughGet, unwrap, wrap } from '../wrap.js'
import { exportSpans, PromiseTracker } from './common.js'
import { instrumentStorage } from './do-storage.js'
import { instrumentEnv } from './env.js'
import {
  gatherIncomingCfAttributes,
  gatherRequestAttributes,
  gatherResponseAttributes,
  getParentContextFromHeaders,
  instrumentClientFetch,
} from './fetch.js'

type FetchFn = DurableObject['fetch']
type AlarmFn = DurableObject['alarm']
type Env = Record<string, unknown>

function instrumentBindingStub(stub: DurableObjectStub, nsName: string): DurableObjectStub {
  const stubHandler: ProxyHandler<typeof stub> = {
    get(target, prop) {
      if (prop === 'fetch') {
        const fetcher = Reflect.get(target, prop)
        const attrs = {
          name: `Durable Object ${nsName}`,
          'do.namespace': nsName,
          'do.id': target.id.toString(),
          'do.id.name': target.id.name,
        }
        return instrumentClientFetch(fetcher, (config) => ({ ...config.fetch, includeTraceContext: true }), attrs)
      } else {
        return passthroughGet(target, prop)
      }
    },
  }
  return wrap(stub, stubHandler)
}

function instrumentBindingGet(getFn: DurableObjectNamespace['get'], nsName: string): DurableObjectNamespace['get'] {
  const getHandler: ProxyHandler<DurableObjectNamespace['get']> = {
    apply(target, thisArg, argArray) {
      const stub: DurableObjectStub = Reflect.apply(target, thisArg, argArray)
      return instrumentBindingStub(stub, nsName)
    },
  }
  return wrap(getFn, getHandler)
}

export function instrumentDOBinding(ns: DurableObjectNamespace, nsName: string): DurableObjectNamespace {
  const nsHandler: ProxyHandler<typeof ns> = {
    get(target, prop) {
      if (prop === 'get') {
        const fn = Reflect.get(ns, prop)
        return instrumentBindingGet(fn, nsName)
      } else {
        return passthroughGet(target, prop)
      }
    },
  }
  return wrap(ns, nsHandler)
}

export function instrumentState(state: DurableObjectState, tracker: PromiseTracker = new PromiseTracker()): DurableObjectState {
  const stateHandler: ProxyHandler<DurableObjectState> = {
    get(target, prop, receiver) {
      const result = Reflect.get(target, prop, unwrap(receiver))
      if (prop === 'storage') {
        return instrumentStorage(result)
      } else if (prop === 'waitUntil') {
        const waitUntil = result as DurableObjectState['waitUntil']
        return (promise: Promise<unknown>) => {
          tracker.track(promise)
          return waitUntil.call(target, promise)
        }
      } else if (typeof result === 'function') {
        return result.bind(target)
      } else {
        return result
      }
    },
  }
  return wrap(state, stateHandler)
}

let cold_start = true
// Classes that extend `DurableObject` from `cloudflare:workers` are RPC-branded and may omit `fetch`.
export type DOClass<Env = Record<string, unknown>> = new (state: DurableObjectState, env: Env) => DurableObject | Rpc.DurableObjectBranded
export async function executeDOFetch(fetchFn: FetchFn, request: Request, id: DurableObjectId): Promise<Response> {
  const spanContext = getParentContextFromHeaders(request.headers)
  const captureHeaders = getActiveConfig()?.handlers?.fetch?.captureHeaders

  const tracer = trace.getTracer('DO fetchHandler')
  const attributes = {
    [ATTR_FAAS_TRIGGER]: 'http',
    [ATTR_FAAS_COLDSTART]: cold_start,
  }
  cold_start = false
  Object.assign(attributes, gatherRequestAttributes(request, captureHeaders?.request))
  Object.assign(attributes, gatherIncomingCfAttributes(request))
  const options: SpanOptions = {
    attributes,
    kind: SpanKind.SERVER,
  }

  const name = id.name || ''
  const promise = tracer.startActiveSpan(`Durable Object Fetch ${name}`, options, spanContext, async (span) => {
    try {
      const response: Response = await fetchFn(request)
      if (response.ok) {
        span.setStatus({ code: SpanStatusCode.OK })
      }
      span.setAttributes(gatherResponseAttributes(response, captureHeaders?.response))
      span.end()

      return response
    } catch (error) {
      span.recordException(error as Exception)
      span.setStatus({ code: SpanStatusCode.ERROR })
      span.end()
      throw error
    }
  })
  return promise
}

export async function executeDOAlarm(alarmFn: NonNullable<AlarmFn>, id: DurableObjectId): Promise<void> {
  const tracer = trace.getTracer('DO alarmHandler')

  const name = id.name || ''
  const promise = tracer.startActiveSpan(`Durable Object Alarm ${name}`, async (span) => {
    span.setAttribute(ATTR_FAAS_COLDSTART, cold_start)
    cold_start = false
    span.setAttribute('do.id', id.toString())
    if (id.name) {
      span.setAttribute('do.name', id.name)
    }

    try {
      await alarmFn()
      span.end()
    } catch (error) {
      span.recordException(error as Exception)
      span.setStatus({ code: SpanStatusCode.ERROR })
      span.end()
      throw error
    }
  })
  return promise
}

// Spans started while constructing the object belong to the constructor's config and still
// need flushing alongside the ones from the current fetch or alarm.
function processorsToFlush(constructorConfig: ResolvedTraceConfig, config: ResolvedTraceConfig): SpanProcessor[] {
  return [...new Set([...constructorConfig.spanProcessors, ...config.spanProcessors])]
}

function instrumentFetchFn(
  fetchFn: FetchFn,
  initialiser: Initialiser,
  env: Env,
  state: DurableObjectState,
  rawState: DurableObjectState,
  tracker: PromiseTracker,
  constructorConfig: ResolvedTraceConfig
): FetchFn {
  const fetchHandler: ProxyHandler<FetchFn> = {
    async apply(target, thisArg, argArray: Parameters<FetchFn>) {
      const request = argArray[0]
      const config = initialiser(env, request)
      const context = setConfig(config)
      try {
        const bound = target.bind(unwrap(thisArg))
        return await api_context.with(context, executeDOFetch, undefined, bound, request, state.id)
      } finally {
        rawState.waitUntil(
          exportSpans(processorsToFlush(constructorConfig, config), tracker).catch((error: unknown) => {
            console.error('Error exporting Durable Object fetch spans:', error)
          })
        )
      }
    },
  }
  return wrap(fetchFn, fetchHandler)
}

function instrumentAlarmFn(
  alarmFn: AlarmFn,
  initialiser: Initialiser,
  env: Env,
  state: DurableObjectState,
  rawState: DurableObjectState,
  tracker: PromiseTracker,
  constructorConfig: ResolvedTraceConfig
) {
  if (!alarmFn) {
    return undefined
  }

  const alarmHandler: ProxyHandler<NonNullable<AlarmFn>> = {
    async apply(target, thisArg) {
      const config = initialiser(env, 'do-alarm')
      const context = setConfig(config)
      try {
        const bound = target.bind(unwrap(thisArg))
        await api_context.with(context, executeDOAlarm, undefined, bound, state.id)
      } finally {
        rawState.waitUntil(
          exportSpans(processorsToFlush(constructorConfig, config), tracker).catch((error: unknown) => {
            console.error('Error exporting Durable Object alarm spans:', error)
          })
        )
      }
    },
  }
  return wrap(alarmFn, alarmHandler)
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | null | undefined)?.then === 'function'
}

// Stays synchronous for synchronous methods so callers that use the result directly keep working.
export function executeDORpc(method: string, fn: () => unknown, id: DurableObjectId): unknown {
  const tracer = trace.getTracer('DO rpcHandler')
  const options: SpanOptions = {
    attributes: {
      [ATTR_FAAS_COLDSTART]: cold_start,
      'do.id': id.toString(),
      'rpc.method': method,
      ...(id.name !== undefined ? { 'do.name': id.name } : {}),
    },
    kind: SpanKind.SERVER,
  }
  cold_start = false
  return tracer.startActiveSpan(`Durable Object RPC ${method}`, options, (span) => {
    const fail = (error: unknown): never => {
      span.recordException(error as Exception)
      span.setStatus({ code: SpanStatusCode.ERROR })
      span.end()
      throw error
    }
    let result: unknown
    try {
      result = fn()
    } catch (error) {
      return fail(error)
    }
    if (isPromiseLike(result)) {
      return Promise.resolve(result).then((value) => {
        span.end()
        return value
      }, fail)
    }
    span.end()
    return result
  })
}

// Covers RPC methods and the WebSocket hibernation handlers, which the runtime calls on the
// object itself rather than through fetch or alarm.
function instrumentMethod(
  doObj: DurableObject,
  method: string,
  fn: (...args: unknown[]) => unknown,
  initialiser: Initialiser,
  env: Env,
  state: DurableObjectState,
  rawState: DurableObjectState,
  tracker: PromiseTracker,
  constructorConfig: ResolvedTraceConfig
) {
  const methodHandler: ProxyHandler<typeof fn> = {
    apply(target, _thisArg, argArray: unknown[]) {
      const trigger: DOConstructorTrigger = {
        id: state.id.toString(),
        ...(state.id.name !== undefined ? { name: state.id.name } : {}),
      }
      const config = initialiser(env, trigger)
      const context = setConfig(config)
      const flush = () => {
        rawState.waitUntil(
          exportSpans(processorsToFlush(constructorConfig, config), tracker).catch((error: unknown) => {
            console.error(`Error exporting Durable Object ${method} spans:`, error)
          })
        )
      }
      const bound = (): unknown => Reflect.apply(target, doObj, argArray)
      let result: unknown
      try {
        result = api_context.with(context, executeDORpc, undefined, method, bound, state.id)
      } catch (error) {
        flush()
        throw error
      }
      if (isPromiseLike(result)) {
        return Promise.resolve(result).finally(flush)
      }
      flush()
      return result
    },
  }
  return wrap(fn, methodHandler)
}

function instrumentDurableObject(
  doObj: DurableObject,
  initialiser: Initialiser,
  env: Env,
  state: DurableObjectState,
  rawState: DurableObjectState,
  tracker: PromiseTracker,
  constructorConfig: ResolvedTraceConfig
) {
  const objHandler: ProxyHandler<DurableObject> = {
    get(target, prop, receiver) {
      if (prop === 'fetch') {
        const fetchFn = Reflect.get(target, prop)
        return instrumentFetchFn(fetchFn, initialiser, env, state, rawState, tracker, constructorConfig)
      } else if (prop === 'alarm') {
        const alarmFn = Reflect.get(target, prop)
        return instrumentAlarmFn(alarmFn, initialiser, env, state, rawState, tracker, constructorConfig)
      } else {
        const result = Reflect.get(target, prop)
        if (typeof result === 'function') {
          if (typeof prop === 'string' && prop !== 'constructor') {
            return instrumentMethod(
              target,
              prop,
              result as (...args: unknown[]) => unknown,
              initialiser,
              env,
              state,
              rawState,
              tracker,
              constructorConfig
            )
          }
          return result.bind(receiver)
        }
        return result
      }
    },
  }
  return wrap(doObj, objHandler)
}

// Classes that extend `DurableObject` from `cloudflare:workers` inherit a native constructor that
// rejects anything but the runtime's own state object, so they cannot receive the proxied state.
// Checking for a native base avoids importing `cloudflare:workers`, which only resolves in workerd.
function extendsNativeClass(doClass: Function): boolean {
  let proto: unknown = Object.getPrototypeOf(doClass)
  while (typeof proto === 'function' && proto !== Function.prototype) {
    if (Function.prototype.toString.call(proto).includes('[native code]')) {
      return true
    }
    proto = Object.getPrototypeOf(proto)
  }
  return false
}

// The base constructor stores the raw state and env as `ctx` and `env`; replacing them lets the
// object's own methods reach the instrumented storage and bindings.
function exposeInstrumented(doObj: object, state: DurableObjectState, env: Env): void {
  for (const [key, value] of [
    ['ctx', state],
    ['env', env],
  ] as const) {
    try {
      Object.defineProperty(doObj, key, { configurable: true, enumerable: true, value, writable: true })
    } catch {
      // Keeps the raw value: the object still works, only its storage and binding spans are lost.
    }
  }
}

export function instrumentDOClass<Env = Record<string, unknown>>(doClass: DOClass<Env>, initialiser: Initialiser): DOClass<Env> {
  const classStyle = extendsNativeClass(doClass)
  const classHandler: ProxyHandler<DOClass<Env>> = {
    construct(target, [orig_state, orig_env]: ConstructorParameters<DOClass<Env>>) {
      const trigger: DOConstructorTrigger = {
        id: orig_state.id.toString(),
        ...(orig_state.id.name !== undefined ? { name: orig_state.id.name } : {}),
      }
      const constructorConfig = initialiser(orig_env as Record<string, unknown>, trigger)
      const context = setConfig(constructorConfig)
      const tracker = new PromiseTracker()
      const state = instrumentState(orig_state, tracker)
      const env = instrumentEnv(orig_env as Record<string, unknown>)
      const DOClassTarget = target
      const createDO = (): DurableObject => {
        if (classStyle) {
          const doObj = new DOClassTarget(orig_state, orig_env) as DurableObject
          exposeInstrumented(doObj, state, env)
          return doObj
        }
        return new DOClassTarget(state, env as Env) as DurableObject
      }
      const doObj = api_context.with(context, createDO)

      return instrumentDurableObject(doObj, initialiser, env, state, orig_state, tracker, constructorConfig)
    },
  }
  return wrap(doClass, classHandler)
}
