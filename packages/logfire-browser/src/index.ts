import { ContextManager, diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { Instrumentation, registerInstrumentations } from '@opentelemetry/instrumentation'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor, BufferConfig, StackContextManager, WebTracerProvider } from '@opentelemetry/sdk-trace-web'
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
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from '@opentelemetry/semantic-conventions/incubating'
import {
  configureLogfireApi,
  debug,
  error,
  fatal,
  info,
  Level,
  log,
  logfireApiConfig,
  LogfireAttributeScrubber,
  NoopAttributeScrubber,
  notice,
  reportError,
  resolveBaseUrl,
  resolveSendToLogfire,
  type ScrubbingOptions,
  serializeAttributes,
  span,
  startSpan,
  trace,
  ULIDGenerator,
  warning,
} from 'logfire'

import { LogfireSpanProcessor } from './LogfireSpanProcessor'
import { OTLPTraceExporterWithDynamicHeaders } from './OTLPTraceExporterWithDynamicHeaders'
export { DiagLogLevel } from '@opentelemetry/api'
export * from 'logfire'

type TraceExporterConfig = NonNullable<typeof OTLPTraceExporter extends new (config: infer T) => unknown ? T : never>

export interface LogfireConfigOptions {
  /**
   * The configuration of the batch span processor.
   */
  batchSpanProcessorConfig?: BufferConfig
  /**
   * Whether to log the spans to the console in addition to sending them to the Logfire API.
   */
  console?: boolean
  /**
   * Pass a context manager (e.g. ZoneContextManager) to use.
   */
  contextManager?: ContextManager

  /**
   * Defines the available internal logging levels for the diagnostic logger.
   */
  diagLogLevel?: DiagLogLevel

  /**
   * The environment this service is running in, e.g. `staging` or `prod`. Sets the deployment.environment.name resource attribute. Useful for filtering within projects in the Logfire UI.
   * Defaults to the `LOGFIRE_ENVIRONMENT` environment variable.
   */
  environment?: string
  /**
   * The instrumentations to register - a common one [is the fetch instrumentation](https://www.npmjs.com/package/@opentelemetry/instrumentation-fetch).
   */
  instrumentations?: (Instrumentation | Instrumentation[])[]
  /**
   * Options for scrubbing sensitive data. Set to False to disable.
   */
  scrubbing?: false | ScrubbingOptions

  /**
   * Name of this service.
   */
  serviceName?: string

  /**
   * Version of this service.
   */
  serviceVersion?: string

  /**
   * configures the trace exporter.
   */
  traceExporterConfig?: TraceExporterConfig

  /**
   * Any additional HTTP headers to be sent with the trace exporter requests.
   * This is useful for authentication or other custom headers.
   */
  traceExporterHeaders?: () => Record<string, string>

  /**
   * The URL of your trace exporter proxy endpoint.
   */
  traceUrl: string
}

function defaultTraceExporterHeaders() {
  return {}
}

export function configure(options: LogfireConfigOptions) {
  if (options.diagLogLevel !== undefined) {
    diag.setLogger(new DiagConsoleLogger(), options.diagLogLevel)
  }

  if (options.scrubbing !== undefined) {
    configureLogfireApi({ scrubbing: options.scrubbing })
  }

  const resource = resourceFromAttributes({
    [ATTR_BROWSER_LANGUAGE]: navigator.language,
    [ATTR_SERVICE_NAME]: options.serviceName ?? 'logfire-browser',
    [ATTR_SERVICE_VERSION]: options.serviceVersion ?? '0.0.1',
    [ATTR_TELEMETRY_SDK_LANGUAGE]: TELEMETRY_SDK_LANGUAGE_VALUE_WEBJS,
    [ATTR_TELEMETRY_SDK_NAME]: 'logfire-browser',
    ...(options.environment ? { [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: options.environment } : {}),
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
    spanProcessors: [
      new LogfireSpanProcessor(
        new BatchSpanProcessor(
          new OTLPTraceExporterWithDynamicHeaders(
            { ...options.traceExporterConfig, url: options.traceUrl },
            options.traceExporterHeaders ?? defaultTraceExporterHeaders
          ),
          options.batchSpanProcessorConfig
        ),
        Boolean(options.console)
      ),
    ],
  })

  tracerProvider.register({
    contextManager: options.contextManager ?? new StackContextManager(),
  })

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

// Create default export by listing all exports explicitly
export default {
  configure,
  configureLogfireApi,
  debug,
  DiagLogLevel,
  error,
  fatal,
  info,
  // Re-export all from logfire
  Level,
  log,
  logfireApiConfig,
  LogfireAttributeScrubber,
  NoopAttributeScrubber,
  notice,
  reportError,
  resolveBaseUrl,
  resolveSendToLogfire,
  serializeAttributes,
  span,
  startSpan,
  trace,
  ULIDGenerator,
  warning,
}
