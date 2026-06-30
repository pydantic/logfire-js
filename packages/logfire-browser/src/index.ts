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
import type { BaggageOptions, JsonSchemaMode, LogfireApiConfigOptions, MinLevel, SamplingOptions, ScrubbingOptions } from 'logfire'
import {
  configureLogfireApi,
  debug,
  error,
  fatal,
  info,
  instrument,
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
  startPendingSpan,
  startSpan,
  TailSamplingProcessor,
  trace,
  ULIDGenerator,
  warning,
  withSettings,
  withTags,
} from 'logfire'

import { BrowserSessionSpanProcessor } from './BrowserSessionSpanProcessor'
import { clearConfiguredBrowserSession, configureBrowserSession, getBrowserSessionId } from './browserSession'
import type { RUMOptions } from './browserSession'
import type { BrowserMetricsOptions, BrowserWebVitalsMetricOptions } from './browserMetrics'
import { BrowserSessionReplayState, startBrowserSessionReplay } from './sessionReplay'
import type { BrowserSessionReplayOptions } from './sessionReplay'
import { assertBrowserWebVitalsMetricsCanStart, startBrowserWebVitals } from './webVitals'
import type { BrowserWebVitalsOptions } from './webVitals'
import { LogfireSpanProcessor } from './LogfireSpanProcessor'
export { DiagLogLevel } from '@opentelemetry/api'
export * from 'logfire'
export { getBrowserSessionId } from './browserSession'
export type { BrowserSessionOptions, BrowserSessionUrlAttributes, RUMOptions } from './browserSession'
export type { BrowserMetricsOptions, BrowserWebVitalsMetricOptions } from './browserMetrics'
export type { BrowserSessionReplayOptions } from './sessionReplay'
export type { BrowserWebVitalsOptions } from './webVitals'

type TraceExporterConfig = NonNullable<typeof OTLPTraceExporter extends new (config: infer T) => unknown ? T : never>

export interface LogfireConfigOptions {
  /**
   * The configuration of the batch span processor.
   */
  batchSpanProcessorConfig?: BufferConfig
  /**
   * Active OpenTelemetry baggage keys to copy to Logfire manual spans/logs as span attributes.
   */
  baggage?: BaggageOptions
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
   * Controls JSON schema metadata for serialized object/array attributes.
   *
   * Defaults to 'rich'. Use 'basic' for legacy broad schemas, or false to omit schema metadata.
   */
  jsonSchema?: JsonSchemaMode
  /**
   * The instrumentations to register - a common one [is the fetch instrumentation](https://www.npmjs.com/package/@opentelemetry/instrumentation-fetch).
   */
  instrumentations?: (Instrumentation | Instrumentation[])[]
  /**
   * Minimum Logfire level to emit for manual log-like spans.
   *
   * Accepts lowercase level names (trace, debug, info, notice, warning, error, fatal)
   * or numeric values from `logfire.Level`. Set to null to disable a previously configured minimum.
   */
  minLevel?: MinLevel | null
  /**
   * Browser OpenTelemetry metrics transport options. Metrics are disabled
   * unless this is configured.
   */
  metrics?: false | BrowserMetricsOptions
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
   * Advanced OpenTelemetry span processors to register with the browser tracer provider.
   *
   * Processors are registered before Logfire's built-in exporting processor.
   */
  spanProcessors?: SpanProcessor[]
  /**
   * Browser real-user monitoring options. RUM capture is opt-in.
   */
  rum?: RUMOptions
  /**
   * Experimental browser session replay options. Replay is disabled unless this
   * is configured.
   *
   * Logfire Platform replay ingest and playback are still feature-flagged, so
   * keep browser replay rollout behind an application flag.
   */
  sessionReplay?: false | BrowserSessionReplayOptions
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

function resolveBrowserWebVitalsOptions(webVitals: RUMOptions['webVitals'] | undefined): BrowserWebVitalsOptions | undefined {
  if (webVitals === undefined || webVitals === false) {
    return undefined
  }

  return webVitals === true ? {} : webVitals
}

function resolveBrowserMetricsOptions(metrics: LogfireConfigOptions['metrics']): BrowserMetricsOptions | undefined {
  if (metrics === undefined || metrics === false) {
    return undefined
  }

  if (metrics.metricUrl === '') {
    throw new Error('logfire-browser: metrics.metricUrl must be a non-empty browser-safe metrics proxy URL')
  }

  return metrics
}

function resolveBrowserWebVitalsMetricOptions(
  webVitalsOptions: BrowserWebVitalsOptions | undefined
): BrowserWebVitalsMetricOptions | undefined {
  if (webVitalsOptions?.metrics === undefined || webVitalsOptions.metrics === false) {
    return undefined
  }

  return webVitalsOptions.metrics === true ? {} : webVitalsOptions.metrics
}

function resolveBrowserSessionReplayOptions(sessionReplay: LogfireConfigOptions['sessionReplay']): BrowserSessionReplayOptions | undefined {
  if (sessionReplay === undefined || sessionReplay === false) {
    return undefined
  }

  return sessionReplay
}

function resolveBrowserSessionOptions(
  rum: RUMOptions | undefined,
  sessionReplayOptions: BrowserSessionReplayOptions | undefined
): RUMOptions['session'] | undefined {
  const webVitalsOptions = resolveBrowserWebVitalsOptions(rum?.webVitals)
  const sessionReplayRequiresSession = sessionReplayOptions !== undefined
  if (webVitalsOptions === undefined && !sessionReplayRequiresSession) {
    return rum?.session
  }

  if (rum?.session === false) {
    if (sessionReplayRequiresSession) {
      throw new Error(
        'logfire-browser: sessionReplay requires browser session attributes; remove rum.session: false or disable sessionReplay'
      )
    }
    throw new Error(
      'logfire-browser: rum.webVitals requires browser session attributes; remove rum.session: false or disable rum.webVitals'
    )
  }

  return rum?.session ?? true
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

  const webVitalsOptions = resolveBrowserWebVitalsOptions(options.rum?.webVitals)
  const sessionReplayOptions = resolveBrowserSessionReplayOptions(options.sessionReplay)
  const browserMetricsOptions = resolveBrowserMetricsOptions(options.metrics)
  const webVitalsMetricOptions = resolveBrowserWebVitalsMetricOptions(webVitalsOptions)
  if (webVitalsMetricOptions !== undefined && browserMetricsOptions === undefined) {
    throw new Error('logfire-browser: rum.webVitals.metrics requires top-level metrics.metricUrl')
  }
  if (webVitalsMetricOptions !== undefined) {
    assertBrowserWebVitalsMetricsCanStart()
  }
  const browserSessionOptions = resolveBrowserSessionOptions(options.rum, sessionReplayOptions)

  const apiConfig: LogfireApiConfigOptions = {
    errorFingerprinting: options.errorFingerprinting ?? false,
  }
  if (options.baggage !== undefined) {
    apiConfig.baggage = options.baggage
  }
  if (options.jsonSchema !== undefined) {
    apiConfig.jsonSchema = options.jsonSchema
  }
  if (options.minLevel !== undefined) {
    apiConfig.minLevel = options.minLevel
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

  // Browser configure intentionally does not install PendingSpanProcessor.
  // Use startPendingSpan() for explicit, per-span pending placeholders.
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

  const browserSessionManager = configureBrowserSession(browserSessionOptions)
  const browserSessionReplayState = new BrowserSessionReplayState()
  const spanProcessors: SpanProcessor[] = []
  if (browserSessionManager !== undefined) {
    spanProcessors.push(new BrowserSessionSpanProcessor(browserSessionManager, browserSessionReplayState))
  }
  spanProcessors.push(...(options.spanProcessors ?? []), spanProcessor)

  const tracerProvider = new WebTracerProvider({
    idGenerator: new ULIDGenerator(),
    resource,
    ...(sampler ? { sampler } : {}),
    spanProcessors,
  })

  tracerProvider.register({
    contextManager: options.contextManager ?? new StackContextManager(),
  })

  const unregister = registerInstrumentations({
    instrumentations: options.instrumentations ?? [],
    tracerProvider,
  })

  const sessionReplayStartupPromise =
    sessionReplayOptions === undefined || browserSessionManager === undefined
      ? undefined
      : startBrowserSessionReplay(sessionReplayOptions, browserSessionManager, browserSessionReplayState, {
          metricUrl: browserMetricsOptions?.metricUrl,
          traceUrl: options.traceUrl,
        })

  const browserMetricsStartupPromise =
    browserMetricsOptions === undefined
      ? undefined
      : import('./browserMetrics')
          .then(async ({ startBrowserMetrics }) => startBrowserMetrics(browserMetricsOptions, resource))
          .catch((error: unknown) => {
            diag.error('logfire-browser: failed to start browser metrics', error)
            return undefined
          })

  const webVitalsStartupPromise =
    webVitalsOptions === undefined
      ? undefined
      : webVitalsMetricOptions === undefined
        ? startBrowserWebVitals(webVitalsOptions).catch((error: unknown) => {
            diag.error('logfire-browser: failed to start Web Vitals reporting', error)
            return undefined
          })
        : (async () => {
            const browserMetrics = await browserMetricsStartupPromise
            if (browserMetrics === undefined) {
              throw new Error('logfire-browser: failed to start Web Vitals metrics because browser metrics transport did not start')
            }

            return startBrowserWebVitals({
              ...webVitalsOptions,
              metricRecorder: browserMetrics.createWebVitalsMetricRecorder(webVitalsMetricOptions),
            })
          })().catch((error: unknown) => {
            diag.error('logfire-browser: failed to start Web Vitals reporting', error)
            return undefined
          })

  let cleanupPromise: Promise<void> | undefined

  // Return the stored promise directly so repeated cleanup calls preserve identity.
  // eslint-disable-next-line @typescript-eslint/promise-function-async
  return () => {
    cleanupPromise ??= (async () => {
      let firstCleanupError: Error | undefined
      const captureCleanupError = (step: string, error: unknown) => {
        const cleanupError = error instanceof Error ? error : new Error(String(error))
        firstCleanupError ??= cleanupError
        diag.error(`logfire-browser: ${step} failed during shutdown`, cleanupError)
      }

      const runCleanupStep = async (step: string, cleanupStep: () => void | Promise<void>) => {
        try {
          await cleanupStep()
        } catch (error) {
          captureCleanupError(step, error)
        }
      }

      diag.info('logfire-browser: shutting down')
      if (sessionReplayStartupPromise !== undefined) {
        browserSessionReplayState.clear()
        await runCleanupStep('session replay shutdown', async () => {
          const sessionReplay = await sessionReplayStartupPromise
          await sessionReplay?.stop()
        })
      }
      await runCleanupStep('instrumentation unregister', unregister)
      if (webVitalsStartupPromise !== undefined) {
        await runCleanupStep('web vitals shutdown', async () => {
          const webVitalsHandle = await webVitalsStartupPromise
          await webVitalsHandle?.shutdown()
        })
      }
      if (browserMetricsStartupPromise !== undefined) {
        await runCleanupStep('metric provider force flush', async () => {
          const browserMetrics = await browserMetricsStartupPromise
          await browserMetrics?.forceFlush()
        })
        await runCleanupStep('metric provider shutdown', async () => {
          const browserMetrics = await browserMetricsStartupPromise
          await browserMetrics?.shutdown()
        })
      }
      await runCleanupStep('force flush', async () => tracerProvider.forceFlush())
      await runCleanupStep('tracer provider shutdown', async () => tracerProvider.shutdown())
      if (browserSessionManager !== undefined) {
        await runCleanupStep('browser session cleanup', () => {
          clearConfiguredBrowserSession(browserSessionManager)
        })
      }

      if (firstCleanupError !== undefined) {
        throw new Error(firstCleanupError.message, { cause: firstCleanupError })
      }

      diag.info('logfire-browser: shut down complete')
    })()

    return cleanupPromise
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
  instrument: typeof instrument
  getBrowserSessionId: typeof getBrowserSessionId
  log: typeof log
  logfireApiConfig: typeof logfireApiConfig
  notice: typeof notice
  reportError: typeof reportError
  resolveBaseUrl: typeof resolveBaseUrl
  resolveSendToLogfire: typeof resolveSendToLogfire
  serializeAttributes: typeof serializeAttributes
  span: typeof span
  startPendingSpan: typeof startPendingSpan
  startSpan: typeof startSpan
  trace: typeof trace
  warning: typeof warning
  withSettings: typeof withSettings
  withTags: typeof withTags
} = {
  configure,
  configureLogfireApi,
  debug,
  DiagLogLevel,
  error,
  fatal,
  getBrowserSessionId,
  info,
  instrument,
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
  startPendingSpan,
  startSpan,
  trace,
  ULIDGenerator,
  warning,
  withSettings,
  withTags,
}

export default defaultExport
