import { propagation } from '@opentelemetry/api'
import type { Resource } from '@opentelemetry/resources'
import { resourceFromAttributes } from '@opentelemetry/resources'

import type { Initialiser } from './config.js'
import { parseConfig } from './config.js'
import { WorkerTracerProvider } from './provider.js'
import type { Trigger, TraceConfig, ResolvedTraceConfig } from './types.js'
import { unwrap } from './wrap.js'
import { createFetchHandler, instrumentGlobalFetch } from './instrumentation/fetch.js'
import { instrumentGlobalCache } from './instrumentation/cache.js'
import { createQueueHandler } from './instrumentation/queue.js'
import type { DOClass } from './instrumentation/do.js'
import { instrumentDOClass } from './instrumentation/do.js'
import { createScheduledHandler } from './instrumentation/scheduled.js'
import { createEmailHandler } from './instrumentation/email.js'
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_NAMESPACE,
  ATTR_SERVICE_VERSION,
  ATTR_TELEMETRY_SDK_LANGUAGE,
  ATTR_TELEMETRY_SDK_NAME,
  ATTR_TELEMETRY_SDK_VERSION,
} from '@opentelemetry/semantic-conventions'
import { ATTR_DEPLOYMENT_ENVIRONMENT_NAME, ATTR_FAAS_MAX_MEMORY } from './semconv.js'

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

const OTEL_CF_WORKERS_PACKAGE_NAME = '@pydantic/otel-cf-workers'

const createResource = (config: ResolvedTraceConfig): Resource => {
  const workerResourceAttrs = {
    'cloud.provider': 'cloudflare',
    'cloud.platform': 'cloudflare.workers',
    'cloud.region': 'earth',
    [ATTR_FAAS_MAX_MEMORY]: 134217728,
    [ATTR_TELEMETRY_SDK_LANGUAGE]: 'js',
    [ATTR_TELEMETRY_SDK_NAME]: OTEL_CF_WORKERS_PACKAGE_NAME,
    [ATTR_TELEMETRY_SDK_VERSION]: PACKAGE_VERSION,
  }
  const serviceResource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.service.name,
    [ATTR_SERVICE_NAMESPACE]: config.service.namespace,
    [ATTR_SERVICE_VERSION]: config.service.version,
    ...(config.environment !== undefined ? { [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.environment } : {}),
  })
  const resource = resourceFromAttributes(workerResourceAttrs)
  return resource.merge(serviceResource)
}

let initialised = false
function init(config: ResolvedTraceConfig): void {
  if (!initialised) {
    if (config.instrumentation.instrumentGlobalCache === true) {
      instrumentGlobalCache()
    }
    if (config.instrumentation.instrumentGlobalFetch === true) {
      instrumentGlobalFetch()
    }
    propagation.setGlobalPropagator(config.propagator)
    const resource = createResource(config)

    const provider = new WorkerTracerProvider(config.spanProcessors, resource, config.scope, config.idGenerator)
    provider.register()
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
