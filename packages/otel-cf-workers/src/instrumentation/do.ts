import type { Exception, SpanOptions } from '@opentelemetry/api'
import { context as api_context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import type { Initialiser } from '../config.js'
import { getActiveConfig, setConfig } from '../config.js'
import { ATTR_FAAS_COLDSTART, ATTR_FAAS_TRIGGER } from '../semconv.js'
import type { DOConstructorTrigger } from '../types.js'
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
export type DOClass<Env = Record<string, unknown>> = new (state: DurableObjectState, env: Env) => DurableObject
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

function instrumentFetchFn(
  fetchFn: FetchFn,
  initialiser: Initialiser,
  env: Env,
  state: DurableObjectState,
  rawState: DurableObjectState,
  tracker: PromiseTracker
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
          exportSpans(tracker).catch((error: unknown) => {
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
  tracker: PromiseTracker
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
          exportSpans(tracker).catch((error: unknown) => {
            console.error('Error exporting Durable Object alarm spans:', error)
          })
        )
      }
    },
  }
  return wrap(alarmFn, alarmHandler)
}

function instrumentDurableObject(
  doObj: DurableObject,
  initialiser: Initialiser,
  env: Env,
  state: DurableObjectState,
  rawState: DurableObjectState,
  tracker: PromiseTracker
) {
  const objHandler: ProxyHandler<DurableObject> = {
    get(target, prop, receiver) {
      if (prop === 'fetch') {
        const fetchFn = Reflect.get(target, prop)
        return instrumentFetchFn(fetchFn, initialiser, env, state, rawState, tracker)
      } else if (prop === 'alarm') {
        const alarmFn = Reflect.get(target, prop)
        return instrumentAlarmFn(alarmFn, initialiser, env, state, rawState, tracker)
      } else {
        const result = Reflect.get(target, prop)
        if (typeof result === 'function') {
          return result.bind(receiver)
        }
        return result
      }
    },
  }
  return wrap(doObj, objHandler)
}

export function instrumentDOClass<Env = Record<string, unknown>>(doClass: DOClass<Env>, initialiser: Initialiser): DOClass<Env> {
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
        return new DOClassTarget(state, env as Env)
      }
      const doObj = api_context.with(context, createDO)

      return instrumentDurableObject(doObj, initialiser, env, state, orig_state, tracker)
    },
  }
  return wrap(doClass, classHandler)
}
