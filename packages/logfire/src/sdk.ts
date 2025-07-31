import { diag, DiagConsoleLogger, metrics } from '@opentelemetry/api'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { detectResources, envDetector, resourceFromAttributes } from '@opentelemetry/resources'
import { MeterProvider } from '@opentelemetry/sdk-metrics'
import { NodeSDK } from '@opentelemetry/sdk-node'
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
import { reportError, ULIDGenerator } from '@pydantic/logfire-api'

import { logfireConfig } from './logfireConfig'
import { periodicMetricReader } from './metricExporter'
import { logfireSpanProcessor } from './traceExporter'
import { removeEmptyKeys } from './utils'

const LOGFIRE_ATTRIBUTES_NAMESPACE = 'logfire'
const RESOURCE_ATTRIBUTES_CODE_ROOT_PATH = `${LOGFIRE_ATTRIBUTES_NAMESPACE}.code.root_path`

export function start() {
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
      // eslint-disable-next-line no-undef
      [ATTR_TELEMETRY_SDK_VERSION]: PACKAGE_VERSION,

      [ATTR_VCS_REPOSITORY_REF_REVISION]: logfireConfig.codeSource?.revision,
      [ATTR_VCS_REPOSITORY_URL_FULL]: logfireConfig.codeSource?.repository,
      [RESOURCE_ATTRIBUTES_CODE_ROOT_PATH]: logfireConfig.codeSource?.rootPath,
    })
  ).merge(detectResources({ detectors: [envDetector] }))

  // use AsyncLocalStorageContextManager to manage parent <> child relationshps in async functions
  const contextManager = new AsyncLocalStorageContextManager()

  const propagator = logfireConfig.distributedTracing ? new W3CTraceContextPropagator() : undefined

  const processor = logfireSpanProcessor(logfireConfig.console)
  const sdk = new NodeSDK({
    autoDetectResources: false,
    contextManager,
    idGenerator: new ULIDGenerator(),
    instrumentations: [getNodeAutoInstrumentations(logfireConfig.nodeAutoInstrumentations), ...logfireConfig.instrumentations],
    metricReader: logfireConfig.metrics === false ? undefined : periodicMetricReader(),
    resource,
    spanProcessors: [processor, ...logfireConfig.additionalSpanProcessors],
    textMapPropagator: propagator,
  })

  if (logfireConfig.metrics && 'additionalReaders' in logfireConfig.metrics) {
    const meterProvider = new MeterProvider({ readers: [periodicMetricReader(), ...logfireConfig.metrics.additionalReaders], resource })
    metrics.setGlobalMeterProvider(meterProvider)
  }

  sdk.start()
  diag.info('logfire: starting')

  process.on('uncaughtExceptionMonitor', (error: Error) => {
    diag.info('logfire: caught uncaught exception', error.message)
    reportError(error.message, error, {})

    // eslint-disable-next-line no-void
    void processor.forceFlush()
  })

  process.on('unhandledRejection', (reason: Error) => {
    diag.error('unhandled rejection', reason)

    if (reason instanceof Error) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      reportError(reason.message ?? 'error', reason, {})
    }
    // eslint-disable-next-line no-void
    void processor.forceFlush()
  })

  // gracefully shut down the SDK on process exit
  process.on('SIGTERM', () => {
    sdk
      .shutdown()
      .catch((e: unknown) => {
        diag.warn('logfire SDK: error shutting down', e)
      })
      .finally(() => {
        diag.info('logfire SDK: shutting down')
      })
  })

  let _shutdown = false

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  process.on('beforeExit', async () => {
    if (!_shutdown) {
      try {
        await sdk.shutdown()
      } catch (e) {
        diag.warn('logfire SDK: error shutting down', e)
      } finally {
        _shutdown = true
        diag.info('logfire SDK: shutting down')
      }
    }
  })
}
