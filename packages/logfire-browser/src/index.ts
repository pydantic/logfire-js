import type { Attributes, ContextManager } from '@opentelemetry/api'
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import type { Instrumentation } from '@opentelemetry/instrumentation'
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { resourceFromAttributes } from '@opentelemetry/resources'
import type { BufferConfig, SpanProcessor } from '@opentelemetry/sdk-trace-web'
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  StackContextManager,
  TraceIdRatioBasedSampler,
  WebTracerProvider,
} from '@opentelemetry/sdk-trace-web'
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
import type { SamplingOptions, ScrubbingOptions } from 'logfire'
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
  serializeAttributes,
  span,
  startSpan,
  TailSamplingProcessor,
  trace,
  ULIDGenerator,
  warning,
} from 'logfire'

import { LogfireSpanProcessor } from './LogfireSpanProcessor'
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
   * Whether to compute fingerprints for errors reported via reportError().
   * Defaults to false for browser since minified code produces unstable fingerprints.
   */
  errorFingerprinting?: boolean
  /**
   * The instrumentations to register - a common one [is the fetch instrumentation](https://www.npmjs.com/package/@opentelemetry/instrumentation-fetch).
   */
  instrumentations?: (Instrumentation | Instrumentation[])[]
  /**
   * Sampling options for controlling which traces are exported.
   * `head` sets a probabilistic sample rate (0.0-1.0) at trace creation time.
   * `tail` provides a callback evaluated on every span to decide whether to keep the trace.
   *
   * Note: Tail sampling buffers all spans in a trace in memory until either a span meets the
   * sampling criteria or the root span ends. In long-lived browser sessions, this can lead to
   * significant memory usage. Consider using head sampling alone for long-running traces, or
   * ensure tail callbacks accept traces quickly (e.g., on the first error-level span).
   */
  sampling?: SamplingOptions
  /**
   * Options for scrubbing sensitive data. Set to False to disable.
   */
  scrubbing?: false | ScrubbingOptions
  /**
   * Additional OpenTelemetry resource attributes for the entity producing telemetry.
   *
   * Use this for stable application or browser-session metadata, not per-request or sensitive user data.
   */
  resourceAttributes?: Attributes

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

async function resolveTraceExporterHeaders(configHeaders: TraceExporterConfig['headers'], dynamicHeaders: () => Record<string, string>) {
  const resolvedConfigHeaders = typeof configHeaders === 'function' ? await configHeaders() : (configHeaders ?? {})

  return {
    ...resolvedConfigHeaders,
    ...dynamicHeaders(),
  }
}

export function configure(options: LogfireConfigOptions): () => Promise<void> {
  if (options.diagLogLevel !== undefined) {
    diag.setLogger(new DiagConsoleLogger(), options.diagLogLevel)
  }

  const apiConfig: {
    errorFingerprinting: boolean
    scrubbing?: false | ScrubbingOptions
  } = {
    errorFingerprinting: options.errorFingerprinting ?? false,
  }
  if (options.scrubbing !== undefined) {
    apiConfig.scrubbing = options.scrubbing
  }
  configureLogfireApi(apiConfig)

  const resource = resourceFromAttributes(options.resourceAttributes ?? {}).merge(
    resourceFromAttributes({
      [ATTR_BROWSER_LANGUAGE]: navigator.language,
      [ATTR_SERVICE_NAME]: options.serviceName ?? 'logfire-browser',
      [ATTR_SERVICE_VERSION]: options.serviceVersion ?? '0.0.1',
      [ATTR_TELEMETRY_SDK_LANGUAGE]: TELEMETRY_SDK_LANGUAGE_VALUE_WEBJS,
      [ATTR_TELEMETRY_SDK_NAME]: 'logfire-browser',
      ...(options.environment !== undefined && options.environment !== ''
        ? { [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: options.environment }
        : {}),
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
  )

  diag.info('logfire-browser: starting')

  const headRate = options.sampling?.head
  const sampler =
    headRate !== undefined && headRate < 1.0 ? new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(headRate) }) : undefined

  let spanProcessor: SpanProcessor = new LogfireSpanProcessor(
    new BatchSpanProcessor(
      new OTLPTraceExporter({
        ...options.traceExporterConfig,
        headers: async () =>
          resolveTraceExporterHeaders(options.traceExporterConfig?.headers, options.traceExporterHeaders ?? defaultTraceExporterHeaders),
        url: options.traceUrl,
      }),
      options.batchSpanProcessorConfig
    ),
    Boolean(options.console)
  )

  if (options.sampling?.tail) {
    spanProcessor = new TailSamplingProcessor(spanProcessor, options.sampling.tail) as unknown as SpanProcessor
  }

  const tracerProvider = new WebTracerProvider({
    idGenerator: new ULIDGenerator(),
    resource,
    ...(sampler ? { sampler } : {}),
    spanProcessors: [spanProcessor],
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

const defaultExport: {
  DiagLogLevel: typeof DiagLogLevel
  Level: typeof Level
  LogfireAttributeScrubber: typeof LogfireAttributeScrubber
  NoopAttributeScrubber: typeof NoopAttributeScrubber
  ULIDGenerator: typeof ULIDGenerator
  configure: typeof configure
  configureLogfireApi: typeof configureLogfireApi
  debug: typeof debug
  error: typeof error
  fatal: typeof fatal
  info: typeof info
  log: typeof log
  logfireApiConfig: typeof logfireApiConfig
  notice: typeof notice
  reportError: typeof reportError
  resolveBaseUrl: typeof resolveBaseUrl
  resolveSendToLogfire: typeof resolveSendToLogfire
  serializeAttributes: typeof serializeAttributes
  span: typeof span
  startSpan: typeof startSpan
  trace: typeof trace
  warning: typeof warning
} = {
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

export default defaultExport
