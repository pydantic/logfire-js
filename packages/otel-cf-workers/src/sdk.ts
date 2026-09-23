import { propagation } from '@opentelemetry/api'

import type { Initialiser } from './config.js'
import { parseConfig } from './config.js'
import { WorkerTracerProvider } from './provider.js'
import { ActiveConfigPropagator } from './propagator.js'
import type { Trigger, TraceConfig, ResolvedTraceConfig } from './types.js'
import { unwrap } from './wrap.js'
import { createFetchHandler, instrumentGlobalFetch } from './instrumentation/fetch.js'
import { instrumentGlobalCache } from './instrumentation/cache.js'
import { createQueueHandler } from './instrumentation/queue.js'
import type { DOClass } from './instrumentation/do.js'
import { instrumentDOClass } from './instrumentation/do.js'
import { createScheduledHandler } from './instrumentation/scheduled.js'
import { createEmailHandler } from './instrumentation/email.js'

type FetchHandler = ExportedHandlerFetchHandler
type ScheduledHandler = ExportedHandlerScheduledHandler
type QueueHandler = ExportedHandlerQueueHandler
type EmailHandler = EmailExportedHandler

export type ResolveConfigFn<Env = unknown> = (env: Env, trigger: Trigger) => TraceConfig
export type ConfigurationOption<Env = unknown> = TraceConfig | ResolveConfigFn<Env>

export function isRequest(trigger: Trigger): trigger is Request {
  return trigger instanceof Request
}

export function isMessageBatch(trigger: Trigger): trigger is MessageBatch {
  return trigger !== 'do-alarm' && 'ackAll' in trigger
}

export function isAlarm(trigger: Trigger): trigger is 'do-alarm' {
  return trigger === 'do-alarm'
}

let initialised = false
/**
 * Once-per-isolate setup. Global fetch/cache patching follows the first resolved config;
 * everything that can differ between tenants (span processors, resource, propagator,
 * sampling) is read from each request's config instead.
 */
function init(config: ResolvedTraceConfig): void {
  if (!initialised) {
    if (config.instrumentation.instrumentGlobalCache === true) {
      instrumentGlobalCache()
    }
    if (config.instrumentation.instrumentGlobalFetch === true) {
      instrumentGlobalFetch()
    }
    propagation.setGlobalPropagator(new ActiveConfigPropagator(config.propagator))
    new WorkerTracerProvider().register()
    initialised = true
  }
}

function createInitialiser<Env>(config: ConfigurationOption<Env>): Initialiser {
  if (typeof config === 'function') {
    return (env, trigger) => {
      const conf = parseConfig(config(env as Env, trigger))
      init(conf)
      return conf
    }
  } else {
    return () => {
      const conf = parseConfig(config)
      init(conf)
      return conf
    }
  }
}

export function instrument<E, Q, C>(handler: ExportedHandler<E, Q, C>, config: ConfigurationOption<E>): ExportedHandler<E, Q, C> {
  const initialiser = createInitialiser(config)

  if (handler.fetch !== undefined) {
    const fetcher = unwrap(handler.fetch) as FetchHandler
    handler.fetch = createFetchHandler(fetcher, initialiser)
  }

  if (handler.scheduled !== undefined) {
    const scheduler = unwrap(handler.scheduled) as ScheduledHandler
    handler.scheduled = createScheduledHandler(scheduler, initialiser)
  }

  if (handler.queue !== undefined) {
    const queuer = unwrap(handler.queue) as QueueHandler
    handler.queue = createQueueHandler(queuer, initialiser)
  }

  if (handler.email !== undefined) {
    const emailer = unwrap(handler.email) as EmailHandler
    handler.email = createEmailHandler(emailer, initialiser)
  }

  return handler
}

export function instrumentDO<Env = Record<string, unknown>>(doClass: DOClass<Env>, config: ConfigurationOption<Env>): DOClass<Env> {
  const initialiser = createInitialiser(config)

  return instrumentDOClass(doClass, initialiser)
}

export { waitUntilTrace } from './instrumentation/fetch.js'

export const __unwrappedFetch: typeof fetch = unwrap(fetch)
