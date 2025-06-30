import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api'
import { ZoneContextManager } from '@opentelemetry/context-zone'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { Instrumentation, registerInstrumentations } from '@opentelemetry/instrumentation'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor, BufferConfig, WebTracerProvider } from '@opentelemetry/sdk-trace-web'
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_TELEMETRY_SDK_LANGUAGE,
  ATTR_TELEMETRY_SDK_NAME,
  ATTR_TELEMETRY_SDK_VERSION,
  ATTR_USER_AGENT_ORIGINAL,
  TELEMETRY_SDK_LANGUAGE_VALUE_WEBJS,
} from '@opentelemetry/semantic-conventions'
import {
  ATTR_BROWSER_BRANDS,
  ATTR_BROWSER_LANGUAGE,
  ATTR_BROWSER_MOBILE,
  ATTR_BROWSER_PLATFORM,
} from '@opentelemetry/semantic-conventions/incubating'
import { ULIDGenerator } from '@pydantic/logfire-api'
import * as logfireApi from '@pydantic/logfire-api'
export { DiagLogLevel } from '@opentelemetry/api'
export * from '@pydantic/logfire-api'

export interface LogfireConfigOptions {
  /**
   * The configuration of the batch span processor.
   */
  batchSpanProcessorConfig?: BufferConfig
  /**
   * Defines the available internal logging levels for the diagnostic logger.
   */
  diagLogLevel?: DiagLogLevel
  /**
   * Set to `false` to disable the [zone context manager](https://www.npmjs.com/package/@opentelemetry/context-zone) usage.
   */
  enableZoneContextManager?: boolean
  /**
   * The instrumentations to register - a common one [is the fetch instrumentation](https://www.npmjs.com/package/@opentelemetry/instrumentation-fetch).
   */
  instrumentations?: (Instrumentation | Instrumentation[])[]
  /**
   * Options for scrubbing sensitive data. Set to False to disable.
   */
  scrubbing?: false | logfireApi.SrubbingOptions
  /**
   * Name of this service.
   */
  serviceName?: string

  /**
   * Version of this service.
   */
  serviceVersion?: string

  /**
   * The URL of your trace exporter proxy endpoint.
   */
  traceUrl: string
}

export function configure(options: LogfireConfigOptions) {
  if (options.diagLogLevel !== undefined) {
    diag.setLogger(new DiagConsoleLogger(), options.diagLogLevel)
  }

  if (options.scrubbing !== undefined) {
    logfireApi.configureLogfireApi({ scrubbing: options.scrubbing })
  }

  const resource = resourceFromAttributes({
    [ATTR_BROWSER_LANGUAGE]: navigator.language,
    [ATTR_SERVICE_NAME]: options.serviceName ?? 'logfire-browser',
    [ATTR_SERVICE_VERSION]: options.serviceVersion ?? '0.0.1',
    [ATTR_TELEMETRY_SDK_LANGUAGE]: TELEMETRY_SDK_LANGUAGE_VALUE_WEBJS,
    [ATTR_TELEMETRY_SDK_NAME]: 'logfire-browser',
    // eslint-disable-next-line no-undef
    [ATTR_TELEMETRY_SDK_VERSION]: PACKAGE_VERSION,
    ...(navigator.userAgentData
      ? {
          [ATTR_BROWSER_BRANDS]: navigator.userAgentData.brands.map((brand) => `${brand.brand} ${brand.version}`),
          [ATTR_BROWSER_MOBILE]: navigator.userAgentData.mobile,
          [ATTR_BROWSER_PLATFORM]: navigator.userAgentData.platform,
        }
      : {
          [ATTR_USER_AGENT_ORIGINAL]: navigator.userAgent,
        }),
  })

  diag.info('logfire-browser: starting')
  const tracerProvider = new WebTracerProvider({
    idGenerator: new ULIDGenerator(),
    resource,
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: options.traceUrl }), options.batchSpanProcessorConfig)],
  })

  if (options.enableZoneContextManager !== false) {
    diag.info('logfire-browser: enable zone context manager')
    tracerProvider.register({
      contextManager: new ZoneContextManager(),
    })
  }

  const unregister = registerInstrumentations({
    instrumentations: options.instrumentations ?? [],
    tracerProvider,
  })

  return async () => {
    diag.info('logfire-browser: shutting down')
    unregister()
    await tracerProvider.forceFlush()
    await tracerProvider.shutdown()
    diag.info('logfire-browser: shut down complete')
  }
}
