import type { LogRecordProcessor } from '@opentelemetry/sdk-logs'
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base'

import { diag, DiagConsoleLogger } from '@opentelemetry/api'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { detectResources, envDetector, resourceFromAttributes } from '@opentelemetry/resources'
import type { MetricReader } from '@opentelemetry/sdk-metrics'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base'
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_TELEMETRY_SDK_LANGUAGE,
  ATTR_TELEMETRY_SDK_NAME,
  ATTR_TELEMETRY_SDK_VERSION,
  TELEMETRY_SDK_LANGUAGE_VALUE_NODEJS,
} from '@opentelemetry/semantic-conventions'
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_VCS_REPOSITORY_REF_REVISION,
  ATTR_VCS_REPOSITORY_URL_FULL,
} from '@opentelemetry/semantic-conventions/incubating'
import { PendingSpanProcessor, reportError, TailSamplingProcessor, ULIDGenerator } from 'logfire'
import { getEvalsSpanProcessor } from 'logfire/evals'
import { configureVariables, shutdownVariables } from 'logfire/vars'

import { logfireConfig } from './logfireConfig'
import { logfireLogRecordProcessor } from './logsExporter'
import { periodicMetricReader } from './metricExporter'
import { logfireSpanProcessor } from './traceExporter'
import { removeEmptyKeys } from './utils'

const DEFAULT_LIFECYCLE_TIMEOUT_MILLIS = 30_000
const PROCESS_HOOK_LIFECYCLE_TIMEOUT_MILLIS = 3_000

export interface LogfireFlushOptions {
  timeoutMillis?: number
}

export interface LogfireShutdownOptions extends LogfireFlushOptions {
  flush?: boolean
}

interface ProcessListeners {
  beforeExit: () => void
  SIGTERM: () => void
  uncaughtExceptionMonitor: (error: Error) => void
  unhandledRejection: (reason: unknown) => void
}

interface ActiveRuntime {
  logRecordProcessors: LogRecordProcessor[]
  metricReaders: MetricReader[]
  processListeners: ProcessListeners | undefined
  sdk: NodeSDK
  shutdownPromise: Promise<void> | undefined
  spanProcessors: SpanProcessor[]
}

interface Deadline {
  expiresAt: number
}

let activeRuntime: ActiveRuntime | undefined

function createDeadline(timeoutMillis = DEFAULT_LIFECYCLE_TIMEOUT_MILLIS): Deadline {
  return { expiresAt: Date.now() + timeoutMillis }
}

function remainingTimeoutMillis(deadline: Deadline): number {
  return Math.max(0, deadline.expiresAt - Date.now())
}

async function withDeadline<T>(label: string, deadline: Deadline, promise: Promise<T>): Promise<T> {
  const timeoutMillis = remainingTimeoutMillis(deadline)
  if (timeoutMillis <= 0) {
    throw new Error(`logfire SDK: ${label} timed out`)
  }

  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`logfire SDK: ${label} timed out`))
        }, timeoutMillis)
      }),
    ])
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }
  }
}

function removeProcessListeners(runtime: ActiveRuntime): void {
  const listeners = runtime.processListeners
  if (listeners === undefined) {
    return
  }
  process.removeListener('beforeExit', listeners.beforeExit)
  process.removeListener('SIGTERM', listeners.SIGTERM)
  process.removeListener('uncaughtExceptionMonitor', listeners.uncaughtExceptionMonitor)
  process.removeListener('unhandledRejection', listeners.unhandledRejection)
  runtime.processListeners = undefined
}

async function flushRuntime(runtime: ActiveRuntime, deadline: Deadline): Promise<void> {
  await withDeadline(
    'forceFlush',
    deadline,
    Promise.all([
      ...runtime.spanProcessors.map(async (processor) => processor.forceFlush()),
      ...runtime.logRecordProcessors.map(async (processor) => processor.forceFlush()),
      ...runtime.metricReaders.map(async (reader) => reader.forceFlush({ timeoutMillis: remainingTimeoutMillis(deadline) })),
    ]).then(() => undefined)
  )
}

async function forceFlushBestEffort(runtime: ActiveRuntime, reason: string): Promise<void> {
  try {
    await flushRuntime(runtime, createDeadline(PROCESS_HOOK_LIFECYCLE_TIMEOUT_MILLIS))
  } catch (e: unknown) {
    diag.warn(`logfire SDK: error flushing during ${reason}`, e)
  }
}

async function shutdownRuntime(runtime: ActiveRuntime, options: LogfireShutdownOptions = {}): Promise<void> {
  if (runtime.shutdownPromise !== undefined) {
    return runtime.shutdownPromise
  }

  runtime.shutdownPromise = (async () => {
    removeProcessListeners(runtime)
    const deadline = createDeadline(options.timeoutMillis)
    const errors: unknown[] = []

    try {
      if (options.flush !== false) {
        try {
          await flushRuntime(runtime, deadline)
        } catch (e: unknown) {
          errors.push(e)
        }
      }

      const shutdownPromise = Promise.all([runtime.sdk.shutdown(), shutdownVariables()]).then(() => undefined)
      shutdownPromise.catch(() => undefined)
      try {
        await withDeadline('shutdown', deadline, shutdownPromise)
      } catch (e: unknown) {
        errors.push(e)
      }

      if (errors.length === 1) {
        throw errors[0]
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, 'logfire SDK: shutdown failed')
      }
    } finally {
      if (activeRuntime === runtime) {
        activeRuntime = undefined
      }
    }
  })()

  return runtime.shutdownPromise
}

/**
 * Force-flush all pending spans to the configured exporter. Mirrors Python's
 * `logfire.force_flush()`. Call this before process exit when the default
 * `beforeExit` cleanup might not have time to finish (e.g. short scripts that
 * top-level-await once and exit).
 */
export async function forceFlush(options: LogfireFlushOptions = {}): Promise<void> {
  const runtime = activeRuntime
  if (runtime === undefined) {
    return
  }
  await flushRuntime(runtime, createDeadline(options.timeoutMillis))
}

/**
 * Shut down the OTel SDK, flushing pending spans and metrics. Idempotent —
 * subsequent calls are no-ops. Mirrors Python's `logfire.shutdown()`.
 */
export async function shutdown(options: LogfireShutdownOptions = {}): Promise<void> {
  const runtime = activeRuntime
  if (runtime === undefined) {
    return
  }
  await shutdownRuntime(runtime, options)
}

const LOGFIRE_ATTRIBUTES_NAMESPACE = 'logfire'
const RESOURCE_ATTRIBUTES_CODE_ROOT_PATH = `${LOGFIRE_ATTRIBUTES_NAMESPACE}.code.root_path`

export function start(): void {
  const previousRuntime = activeRuntime
  if (previousRuntime !== undefined) {
    activeRuntime = undefined
    removeProcessListeners(previousRuntime)
    shutdownRuntime(previousRuntime).catch((e: unknown) => {
      diag.warn('logfire SDK: error shutting down previous SDK', e)
    })
  }

  if (logfireConfig.diagLogLevel !== undefined) {
    diag.setLogger(new DiagConsoleLogger(), logfireConfig.diagLogLevel)
  }

  const resource = resourceFromAttributes(logfireConfig.resourceAttributes)
    .merge(
      resourceFromAttributes(
        removeEmptyKeys({
          [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: logfireConfig.deploymentEnvironment,
          [ATTR_SERVICE_NAME]: logfireConfig.serviceName,
          [ATTR_SERVICE_VERSION]: logfireConfig.serviceVersion,
          [ATTR_TELEMETRY_SDK_LANGUAGE]: TELEMETRY_SDK_LANGUAGE_VALUE_NODEJS,
          [ATTR_TELEMETRY_SDK_NAME]: 'logfire',
          [ATTR_TELEMETRY_SDK_VERSION]: PACKAGE_VERSION,

          [ATTR_VCS_REPOSITORY_REF_REVISION]: logfireConfig.codeSource?.revision,
          [ATTR_VCS_REPOSITORY_URL_FULL]: logfireConfig.codeSource?.repository,
          [RESOURCE_ATTRIBUTES_CODE_ROOT_PATH]: logfireConfig.codeSource?.rootPath,
        })
      )
    )
    .merge(detectResources({ detectors: [envDetector] }))
  configureVariables(logfireConfig.variables, {
    ...(logfireConfig.apiKey !== undefined && logfireConfig.apiKey !== '' ? { apiKey: logfireConfig.apiKey } : {}),
    ...(logfireConfig.variablesBaseUrl !== undefined ? { baseUrl: logfireConfig.variablesBaseUrl } : {}),
    resourceAttributes: { ...resource.attributes },
  })

  // use AsyncLocalStorageContextManager to manage parent <> child relationshps in async functions
  const contextManager = new AsyncLocalStorageContextManager()

  const propagator = logfireConfig.distributedTracing ? new W3CTraceContextPropagator() : undefined

  const primarySpanProcessor = logfireSpanProcessor(logfireConfig.console)
  const spanProcessors: SpanProcessor[] = []
  if (logfireConfig.sampling?.tail) {
    spanProcessors.push(new TailSamplingProcessor(primarySpanProcessor, logfireConfig.sampling.tail))
  } else {
    spanProcessors.push(primarySpanProcessor, new PendingSpanProcessor(primarySpanProcessor))
  }
  const evalsSpanProcessor = getEvalsSpanProcessor()
  spanProcessors.push(evalsSpanProcessor, ...logfireConfig.additionalSpanProcessors)

  const headRate = logfireConfig.sampling?.head
  const sampler =
    headRate !== undefined && headRate < 1.0 ? new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(headRate) }) : undefined

  const logProcessor = logfireLogRecordProcessor()
  const logRecordProcessors = logProcessor === null ? [] : [logProcessor]
  const metricReaders =
    logfireConfig.metrics === false
      ? []
      : [
          periodicMetricReader(),
          ...(logfireConfig.metrics !== undefined && 'additionalReaders' in logfireConfig.metrics
            ? logfireConfig.metrics.additionalReaders
            : []),
        ]

  const sdk = new NodeSDK({
    autoDetectResources: false,
    contextManager,
    idGenerator: new ULIDGenerator(),
    instrumentations: [getNodeAutoInstrumentations(logfireConfig.nodeAutoInstrumentations), ...logfireConfig.instrumentations],
    ...(logProcessor ? { logRecordProcessors: [logProcessor] } : {}),
    ...(metricReaders.length === 0 ? {} : { metricReaders }),
    resource,
    ...(sampler ? { sampler } : {}),
    spanProcessors,
    ...(propagator !== undefined ? { textMapPropagator: propagator } : {}),
  })

  const runtime: ActiveRuntime = {
    logRecordProcessors,
    metricReaders,
    processListeners: undefined,
    sdk,
    shutdownPromise: undefined,
    spanProcessors,
  }
  activeRuntime = runtime
  sdk.start()
  diag.info('logfire: starting')

  let _shutdown = false
  const listeners = {
    beforeExit: () => {
      if (_shutdown) {
        return
      }
      _shutdown = true
      shutdownRuntime(runtime, { timeoutMillis: PROCESS_HOOK_LIFECYCLE_TIMEOUT_MILLIS })
        .catch((e: unknown) => {
          diag.warn('logfire SDK: error shutting down', e)
        })
        .finally(() => {
          diag.info('logfire SDK: shutting down')
        })
    },
    SIGTERM: () => {
      shutdownRuntime(runtime, { timeoutMillis: PROCESS_HOOK_LIFECYCLE_TIMEOUT_MILLIS })
        .catch((e: unknown) => {
          diag.warn('logfire SDK: error shutting down', e)
        })
        .finally(() => {
          diag.info('logfire SDK: shutting down')
        })
    },
    uncaughtExceptionMonitor: (error: Error) => {
      diag.info('logfire: caught uncaught exception', error.message)
      try {
        reportError(error.message, error, {})
      } catch (err: unknown) {
        diag.warn('logfire: failed to report error', err)
      }
      // eslint-disable-next-line no-void
      void forceFlushBestEffort(runtime, 'uncaughtExceptionMonitor')
    },
    unhandledRejection: (reason: unknown) => {
      diag.error('unhandled rejection', reason)

      if (reason instanceof Error) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          reportError(reason.message ?? 'error', reason, {})
        } catch (err: unknown) {
          diag.warn('logfire: failed to report error', err)
        }
      }
      // eslint-disable-next-line no-void
      void forceFlushBestEffort(runtime, 'unhandledRejection')
    },
  }
  runtime.processListeners = listeners

  process.on('beforeExit', listeners.beforeExit)
  process.on('SIGTERM', listeners.SIGTERM)
  process.on('uncaughtExceptionMonitor', listeners.uncaughtExceptionMonitor)
  process.on('unhandledRejection', listeners.unhandledRejection)
}
