import type { LogRecordProcessor } from '@opentelemetry/sdk-logs'
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base'

import { diag, DiagConsoleLogger, metrics } from '@opentelemetry/api'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { detectResources, envDetector, resourceFromAttributes } from '@opentelemetry/resources'
import { MeterProvider } from '@opentelemetry/sdk-metrics'
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
import { reportError, TailSamplingProcessor, ULIDGenerator } from 'logfire'
import { getEvalsSpanProcessor } from 'logfire/evals'

import { logfireConfig } from './logfireConfig'
import { logfireLogRecordProcessor } from './logsExporter'
import { periodicMetricReader } from './metricExporter'
import { logfireSpanProcessor } from './traceExporter'
import { removeEmptyKeys } from './utils'

let activeSdk: NodeSDK | undefined
let activeLogProcessor: LogRecordProcessor | undefined
let activeProcessor: SpanProcessor | undefined
let activeProcessListeners:
  | undefined
  | {
      beforeExit: () => void
      SIGTERM: () => void
      uncaughtExceptionMonitor: (error: Error) => void
      unhandledRejection: (reason: unknown) => void
    }

function removeActiveProcessListeners(): void {
  if (activeProcessListeners === undefined) {
    return
  }
  process.removeListener('beforeExit', activeProcessListeners.beforeExit)
  process.removeListener('SIGTERM', activeProcessListeners.SIGTERM)
  process.removeListener('uncaughtExceptionMonitor', activeProcessListeners.uncaughtExceptionMonitor)
  process.removeListener('unhandledRejection', activeProcessListeners.unhandledRejection)
  activeProcessListeners = undefined
}

/**
 * Force-flush all pending spans to the configured exporter. Mirrors Python's
 * `logfire.force_flush()`. Call this before process exit when the default
 * `beforeExit` cleanup might not have time to finish (e.g. short scripts that
 * top-level-await once and exit).
 */
export async function forceFlush(): Promise<void> {
  await Promise.all([activeProcessor?.forceFlush(), activeLogProcessor?.forceFlush()])
}

/**
 * Shut down the OTel SDK, flushing pending spans and metrics. Idempotent —
 * subsequent calls are no-ops. Mirrors Python's `logfire.shutdown()`.
 */
export async function shutdown(): Promise<void> {
  const sdk = activeSdk
  if (sdk === undefined) {
    return
  }
  removeActiveProcessListeners()
  activeSdk = undefined
  activeLogProcessor = undefined
  activeProcessor = undefined
  await sdk.shutdown()
}

const LOGFIRE_ATTRIBUTES_NAMESPACE = 'logfire'
const RESOURCE_ATTRIBUTES_CODE_ROOT_PATH = `${LOGFIRE_ATTRIBUTES_NAMESPACE}.code.root_path`

export function start(): void {
  if (activeSdk !== undefined) {
    shutdown().catch((e: unknown) => {
      diag.warn('logfire SDK: error shutting down previous SDK', e)
    })
  }

  if (logfireConfig.diagLogLevel !== undefined) {
    diag.setLogger(new DiagConsoleLogger(), logfireConfig.diagLogLevel)
  }

  const resource = resourceFromAttributes(
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
  ).merge(detectResources({ detectors: [envDetector] }))

  // use AsyncLocalStorageContextManager to manage parent <> child relationshps in async functions
  const contextManager = new AsyncLocalStorageContextManager()

  const propagator = logfireConfig.distributedTracing ? new W3CTraceContextPropagator() : undefined

  let processor: SpanProcessor = logfireSpanProcessor(logfireConfig.console)
  if (logfireConfig.sampling?.tail) {
    processor = new TailSamplingProcessor(processor, logfireConfig.sampling.tail)
  }
  activeProcessor = processor

  const headRate = logfireConfig.sampling?.head
  const sampler =
    headRate !== undefined && headRate < 1.0 ? new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(headRate) }) : undefined

  const logProcessor = logfireLogRecordProcessor()
  activeLogProcessor = logProcessor ?? undefined

  const sdk = new NodeSDK({
    autoDetectResources: false,
    contextManager,
    idGenerator: new ULIDGenerator(),
    instrumentations: [getNodeAutoInstrumentations(logfireConfig.nodeAutoInstrumentations), ...logfireConfig.instrumentations],
    ...(logProcessor ? { logRecordProcessors: [logProcessor] } : {}),
    ...(logfireConfig.metrics === false ? {} : { metricReader: periodicMetricReader() }),
    resource,
    ...(sampler ? { sampler } : {}),
    spanProcessors: [processor, getEvalsSpanProcessor(), ...logfireConfig.additionalSpanProcessors],
    ...(propagator !== undefined ? { textMapPropagator: propagator } : {}),
  })

  if (logfireConfig.metrics !== undefined && logfireConfig.metrics !== false && 'additionalReaders' in logfireConfig.metrics) {
    const meterProvider = new MeterProvider({ readers: [periodicMetricReader(), ...logfireConfig.metrics.additionalReaders], resource })
    metrics.setGlobalMeterProvider(meterProvider)
  }

  activeSdk = sdk
  sdk.start()
  diag.info('logfire: starting')

  let _shutdown = false
  const listeners = {
    beforeExit: () => {
      if (_shutdown) {
        return
      }
      _shutdown = true
      shutdown()
        .catch((e: unknown) => {
          diag.warn('logfire SDK: error shutting down', e)
        })
        .finally(() => {
          diag.info('logfire SDK: shutting down')
        })
    },
    SIGTERM: () => {
      shutdown()
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
      void processor.forceFlush()
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
      void processor.forceFlush()
    },
  }
  activeProcessListeners = listeners

  process.on('beforeExit', listeners.beforeExit)
  process.on('SIGTERM', listeners.SIGTERM)
  process.on('uncaughtExceptionMonitor', listeners.uncaughtExceptionMonitor)
  process.on('unhandledRejection', listeners.unhandledRejection)
}
