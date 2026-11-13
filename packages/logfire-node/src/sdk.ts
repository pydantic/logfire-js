import type { LogRecordProcessor } from '@opentelemetry/sdk-logs'
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base'

import { context, diag, DiagConsoleLogger, metrics, propagation, trace } from '@opentelemetry/api'
import { logs } from '@opentelemetry/api-logs'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from '@opentelemetry/core'
import type { Instrumentation } from '@opentelemetry/instrumentation'
import { detectResources, envDetector, resourceFromAttributes } from '@opentelemetry/resources'
import type { MetricReader } from '@opentelemetry/sdk-metrics'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base'
import {
  ATTR_SERVICE_INSTANCE_ID,
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
import { DebugIdSpanProcessor, logfireApiConfig, PendingSpanProcessor, reportError, TailSamplingProcessor, ULIDGenerator } from 'logfire'
import { getEvalsSpanProcessor } from 'logfire/evals'
import { configureVariables, shutdownVariables } from 'logfire/vars'

import type { FleetHook } from './fleet'

import { fleetTarget, loadFleet, samplerFromEnv, warnFleetOptionsKept, warnUnmanaged } from './fleet'
import { logfireConfig } from './logfireConfig'
import { logfireLogRecordProcessor } from './logsExporter'
import { NoExtractPropagator } from './noExtractPropagator'
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
  retainedInstrumentations?: ReadonlySet<Instrumentation>
  shutdownVariables?: boolean
  /** Say goodbye to the Fleet server. Not when a new configuration under Fleet takes over: it joins under the same client. */
  stopFleet?: boolean
}

interface ProcessListeners {
  beforeExit: () => void
  SIGTERM: () => void
  uncaughtExceptionMonitor: (error: Error) => void
  unhandledRejection: (reason: unknown) => void
}

type LogfireSignalListenerState = 'logfire-only' | 'user-listeners-present' | 'logfire-missing-no-others' | 'logfire-missing-with-others'

interface ActiveRuntime {
  fleet: FleetHook | undefined
  instrumentations: Instrumentation[]
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
let globalsRegistrant: ActiveRuntime | undefined
// What the running Fleet client joined with: it is one per process, and a later hook shares it.
let joinedFleetTarget: string | undefined

function safelyDisable(disable: () => void): void {
  try {
    disable()
  } catch (e: unknown) {
    diag.warn('logfire SDK: error during teardown', e)
  }
}

// NodeSDK.start() registers the OTel API globals but its shutdown() never
// unregisters them, and the API refuses duplicate registration — leaving them
// behind makes the next start() silently keep routing to this dead runtime.
function releaseRuntimeGlobals(runtime: ActiveRuntime, retainedInstrumentations?: ReadonlySet<Instrumentation>): void {
  for (const instrumentation of runtime.instrumentations) {
    // Instances the replacement configuration reuses must keep their patches:
    // disable() flips only the private enabled flag, and registerInstrumentations
    // skips enable() while getConfig().enabled is true, stranding them disabled.
    if (retainedInstrumentations?.has(instrumentation) === true) {
      continue
    }
    safelyDisable(() => {
      instrumentation.disable()
    })
  }
  if (globalsRegistrant !== runtime) {
    return
  }
  globalsRegistrant = undefined
  safelyDisable(() => {
    trace.disable()
  })
  safelyDisable(() => {
    metrics.disable()
  })
  safelyDisable(() => {
    propagation.disable()
  })
  safelyDisable(() => {
    context.disable()
  })
  safelyDisable(() => {
    logs.disable()
  })
}

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

/**
 * Await every operation, collecting each failure as its own operation settles rather than reading
 * a combined result. `Promise.all` rejects with the first failure and never surfaces the rest,
 * and waiting for a combined settled result instead would lose an early failure whenever another
 * operation outlives the deadline. All operations are already in flight, so this only waits for
 * what was started, and the deadline still bounds the wait (a deadline error joins the list).
 */
async function settleWithDeadline(label: string, deadline: Deadline, operations: Promise<unknown>[]): Promise<unknown[]> {
  const errors: unknown[] = []
  const settled = Promise.all(
    operations.map(async (operation) => {
      try {
        await operation
      } catch (e: unknown) {
        errors.push(e)
      }
    })
  )
  try {
    await withDeadline(
      label,
      deadline,
      settled.then(() => undefined)
    )
  } catch (e: unknown) {
    errors.push(e)
  }
  return errors
}

async function flushRuntime(runtime: ActiveRuntime, deadline: Deadline): Promise<void> {
  const errors = await settleWithDeadline('forceFlush', deadline, [
    ...runtime.spanProcessors.map(async (processor) => processor.forceFlush()),
    ...runtime.logRecordProcessors.map(async (processor) => processor.forceFlush()),
    ...runtime.metricReaders.map(async (reader) => reader.forceFlush({ timeoutMillis: remainingTimeoutMillis(deadline) })),
  ])
  if (errors.length === 1) {
    throw errors[0]
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'logfire SDK: forceFlush failed')
  }
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

function crashReportMessage(value: unknown, fallback: string): string {
  try {
    const message: unknown = value instanceof Error ? value.message : undefined
    return typeof message === 'string' && message !== '' ? message : fallback
  } catch {
    return fallback
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
    // Must run synchronously before the first await: start() relies on the
    // globals being free before the replacement NodeSDK registers its own.
    releaseRuntimeGlobals(runtime, options.retainedInstrumentations)
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

      // Read after the flush: a configure() during it may have put a newer runtime on the same client.
      const clientInUse = activeRuntime !== runtime && activeRuntime?.fleet !== undefined
      if (runtime.fleet !== undefined && options.stopFleet !== false && !clientInUse) {
        joinedFleetTarget = undefined
        // The try is for a hook that throws at once, which must not skip the SDK's own shutdown below.
        try {
          // Before the SDK's own shutdown: goodbye to the Fleet server while the client still runs.
          errors.push(...(await settleWithDeadline('Fleet shutdown', deadline, [runtime.fleet.shutdown()])))
        } catch (e: unknown) {
          errors.push(e)
        }
      }
      const shutdownOperations = [runtime.sdk.shutdown()]
      if (options.shutdownVariables !== false) {
        shutdownOperations.push(shutdownVariables())
      }
      errors.push(...(await settleWithDeadline('shutdown', deadline, shutdownOperations)))

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
  if (logfireConfig.diagLogLevel !== undefined) {
    diag.setLogger(new DiagConsoleLogger(), logfireConfig.diagLogLevel)
  }

  // The Fleet client, where `fleet` is set and it can run: it is called below where the policy acts.
  const fleet = logfireConfig.fleet === undefined ? undefined : loadFleet(logfireConfig.fleet)
  if (fleet !== undefined && logfireConfig.fleet !== undefined) {
    const target = fleetTarget(logfireConfig.fleet)
    if (joinedFleetTarget !== undefined && joinedFleetTarget !== target) {
      warnFleetOptionsKept()
    }
    joinedFleetTarget ??= target
  }

  const previousRuntime = activeRuntime
  if (previousRuntime !== undefined) {
    activeRuntime = undefined
    removeProcessListeners(previousRuntime)
    shutdownRuntime(previousRuntime, {
      retainedInstrumentations: new Set(logfireConfig.instrumentations),
      shutdownVariables: false,
      // Kept where the new SDK runs under Fleet too: it governs the new SDK under the same client.
      stopFleet: fleet === undefined,
    }).catch((e: unknown) => {
      diag.warn('logfire SDK: error shutting down previous SDK', e)
    })
  }

  // Low-precedence fallback, matching Python Logfire's `fallback_resource_attributes`: every
  // later merge wins, so `resourceAttributes` and `OTEL_RESOURCE_ATTRIBUTES` still override it.
  // Under Fleet, the instance ID Fleet knows this process by is merged last.
  const resource = resourceFromAttributes({ [ATTR_SERVICE_INSTANCE_ID]: crypto.randomUUID().replaceAll('-', '') })
    .merge(resourceFromAttributes(logfireConfig.resourceAttributes))
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
    .merge(resourceFromAttributes(fleet?.resourceAttributes ?? {}))
  configureVariables(logfireConfig.variables, {
    ...(logfireConfig.apiKey !== undefined && logfireConfig.apiKey !== '' ? { apiKey: logfireConfig.apiKey } : {}),
    ...(logfireConfig.variablesBaseUrl !== undefined ? { baseUrl: logfireConfig.variablesBaseUrl } : {}),
    resourceAttributes: { ...resource.attributes },
  })

  // use AsyncLocalStorageContextManager to manage parent <> child relationshps in async functions
  const contextManager = new AsyncLocalStorageContextManager()

  // Leaving textMapPropagator unset makes NodeSDK install its default extracting propagators.
  const basePropagator = new CompositePropagator({
    propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
  })
  const propagator = logfireConfig.distributedTracing ? basePropagator : new NoExtractPropagator(basePropagator)

  const primarySpanProcessor = logfireSpanProcessor(logfireConfig.console)
  // First, so the exporting processors that follow see the debug IDs it adds at span end.
  const spanProcessors: SpanProcessor[] = [new DebugIdSpanProcessor()]
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
  const headSampler =
    headRate !== undefined && headRate < 1.0 ? new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(headRate) }) : undefined
  // Under Fleet, the live sampler: the SDK's own until the Fleet policy sets a sampling rate or rules.
  const sampler = fleet === undefined ? headSampler : fleet.headSampler(headSampler ?? samplerFromEnv())

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

  const instrumentations = [...getNodeAutoInstrumentations(logfireConfig.nodeAutoInstrumentations), ...logfireConfig.instrumentations]

  const sdk = new NodeSDK({
    autoDetectResources: false,
    contextManager,
    idGenerator: new ULIDGenerator(),
    instrumentations,
    ...(logProcessor ? { logRecordProcessors: [logProcessor] } : {}),
    // Always set: without it, NodeSDK builds an OTLP reader from OTEL_METRICS_EXPORTER even under `metrics: false`.
    metricReaders,
    resource,
    ...(sampler ? { sampler } : {}),
    spanProcessors,
    textMapPropagator: propagator,
  })

  const runtime: ActiveRuntime = {
    fleet,
    instrumentations,
    logRecordProcessors,
    metricReaders,
    processListeners: undefined,
    sdk,
    shutdownPromise: undefined,
    spanProcessors,
  }
  activeRuntime = runtime
  // Marked before start() so a mid-registration throw still gets its partially
  // registered globals disabled by the next teardown. Deliberately tracks the
  // attempt rather than registration success (registerGlobal refuses duplicates
  // without throwing): last-configure-wins is the accepted policy even when the
  // host app pre-registered its own globals — see PRP 032, Unknowns & Risks.
  globalsRegistrant = runtime
  if (fleet === undefined) {
    sdk.start()
  } else {
    // The Fleet client starts the SDK, so it knows the providers it registers, then puts the
    // policy's gates on every exporter on them and joins the fleet.
    const sdkStart: { started: boolean; threw: boolean } = { started: false, threw: false }
    try {
      fleet.start(() => {
        sdkStart.started = true
        try {
          sdk.start()
        } catch (e: unknown) {
          sdkStart.threw = true
          throw e
        }
      }, resource)
    } catch (e: unknown) {
      if (sdkStart.threw) {
        throw e
      }
      warnUnmanaged(`Logfire Fleet could not start (${String(e)})`)
      if (!sdkStart.started) {
        sdk.start()
      }
    }
  }
  // registerInstrumentations assumes instances arrive enabled from their
  // constructor, so one disabled by an earlier generation's teardown (reuse
  // after a generation gap, or a shutdown() racing this configure) stays
  // disabled unless re-enabled here; enable() is a no-op when already enabled.
  for (const instrumentation of logfireConfig.instrumentations) {
    try {
      instrumentation.enable()
    } catch (e: unknown) {
      diag.warn('logfire SDK: error enabling instrumentation', e)
    }
  }
  // Re-fetch after registration: the previous tracer permanently caches its
  // delegate, so it would keep pointing at the superseded provider.
  logfireApiConfig.tracer = trace.getTracer(logfireApiConfig.otelScope)
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
    uncaughtExceptionMonitor: (error: unknown) => {
      try {
        const message = crashReportMessage(error, 'Uncaught error')
        diag.info('logfire: caught uncaught exception', message)
        try {
          reportError(message, error, {})
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

        try {
          reportError(crashReportMessage(reason, 'Unhandled promise rejection'), reason, {})
        } catch (err: unknown) {
          diag.warn('logfire: failed to report error', err)
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
