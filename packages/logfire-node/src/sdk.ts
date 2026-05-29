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

interface ShutdownRuntimeOptions extends LogfireShutdownOptions {
  shutdownVariables?: boolean
}

interface ProcessListeners {
  beforeExit: () => void
  SIGTERM: () => void
  uncaughtExceptionMonitor: (error: Error) => void
  unhandledRejection: (reason: unknown) => void
}

type LogfireSignalListenerState = 'logfire-only' | 'user-listeners-present' | 'logfire-missing-no-others' | 'logfire-missing-with-others'

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

function runProcessHookBestEffort(operation: () => Promise<void>, errorMessage: string): void {
  try {
    operation().catch((e: unknown) => {
      diag.warn(errorMessage, e)
    })
  } catch (e: unknown) {
    diag.warn(errorMessage, e)
  }
}

async function shutdownBestEffort(runtime: ActiveRuntime, reason: string): Promise<void> {
  try {
    await shutdownRuntime(runtime, { timeoutMillis: PROCESS_HOOK_LIFECYCLE_TIMEOUT_MILLIS })
  } catch (e: unknown) {
    diag.warn(`logfire SDK: error shutting down during ${reason}`, e)
  }
}

function getLogfireSignalListenerState(signal: NodeJS.Signals, logfireListener: () => void): LogfireSignalListenerState {
  const listeners = process.listeners(signal)
  const hasLogfireListener = listeners.some((listener) => listener === logfireListener)

  if (hasLogfireListener) {
    return listeners.length === 1 ? 'logfire-only' : 'user-listeners-present'
  }

  return listeners.length === 0 ? 'logfire-missing-no-others' : 'logfire-missing-with-others'
}

function shouldReemitSignal(listenerState: LogfireSignalListenerState): boolean {
  return listenerState === 'logfire-only' || listenerState === 'logfire-missing-no-others'
}

async function handleSIGTERM(runtime: ActiveRuntime, listener: () => void): Promise<void> {
  const listenerState = getLogfireSignalListenerState('SIGTERM', listener)

  await shutdownBestEffort(runtime, 'SIGTERM')

  if (!shouldReemitSignal(listenerState)) {
    diag.debug('logfire SDK: leaving SIGTERM termination to application handlers', listenerState)
    return
  }

  try {
    process.kill(process.pid, 'SIGTERM')
  } catch (e: unknown) {
    diag.warn('logfire SDK: error re-emitting SIGTERM', e)
  }
}

async function shutdownRuntime(runtime: ActiveRuntime, options: ShutdownRuntimeOptions = {}): Promise<void> {
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

      const shutdownOperations = [runtime.sdk.shutdown()]
      if (options.shutdownVariables !== false) {
        shutdownOperations.push(shutdownVariables())
      }
      const shutdownPromise = Promise.all(shutdownOperations).then(() => undefined)
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
    shutdownRuntime(previousRuntime, { shutdownVariables: false }).catch((e: unknown) => {
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
    spanProcessors.push(
      new TailSamplingProcessor(primarySpanProcessor, logfireConfig.sampling.tail, {
        deferredProcessor: new PendingSpanProcessor(primarySpanProcessor),
      })
    )
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

  const listeners: ProcessListeners = {
    beforeExit: () => {
      runProcessHookBestEffort(async () => {
        await shutdownBestEffort(runtime, 'beforeExit')
        diag.info('logfire SDK: shutting down')
      }, 'logfire SDK: error handling beforeExit')
    },
    SIGTERM: () => {
      runProcessHookBestEffort(async () => {
        await handleSIGTERM(runtime, listeners.SIGTERM)
        diag.info('logfire SDK: shutting down')
      }, 'logfire SDK: error handling SIGTERM')
    },
    uncaughtExceptionMonitor: (error: Error) => {
      try {
        diag.info('logfire: caught uncaught exception', error.message)
        try {
          reportError(error.message, error, {})
        } catch (err: unknown) {
          diag.warn('logfire: failed to report error', err)
        }
        // `uncaughtExceptionMonitor` preserves Node's default crash behavior, so
        // async flush completion here is best-effort only.
        // eslint-disable-next-line no-void
        void forceFlushBestEffort(runtime, 'uncaughtExceptionMonitor')
      } catch (e: unknown) {
        diag.warn('logfire SDK: error handling uncaughtExceptionMonitor', e)
      }
    },
    unhandledRejection: (reason: unknown) => {
      try {
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
      } catch (e: unknown) {
        diag.warn('logfire SDK: error handling unhandledRejection', e)
      }
    },
  }
  runtime.processListeners = listeners

  process.on('beforeExit', listeners.beforeExit)
  process.on('SIGTERM', listeners.SIGTERM)
  process.on('uncaughtExceptionMonitor', listeners.uncaughtExceptionMonitor)
  process.on('unhandledRejection', listeners.unhandledRejection)
}
