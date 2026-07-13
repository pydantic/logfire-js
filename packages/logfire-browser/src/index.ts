import type { Attributes, ContextManager } from '@opentelemetry/api'
import type { InstrumentationConfigMap as WebAutoInstrumentationConfigMap } from '@opentelemetry/auto-instrumentations-web'
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import type { Instrumentation } from '@opentelemetry/instrumentation'
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { resourceFromAttributes } from '@opentelemetry/resources'
import type { BufferConfig, SpanProcessor } from '@opentelemetry/sdk-trace-web'
import { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler, WebTracerProvider } from '@opentelemetry/sdk-trace-web'
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
import type { BrowserSessionReplayControl, BrowserSessionReplayOptions } from './sessionReplay'
import { startBrowserWebVitals } from './webVitals'
import type { BrowserWebVitalsOptions } from './webVitals'
import { LogfireSpanProcessor } from './LogfireSpanProcessor'
import {
  activateProviderGeneration,
  assertProviderLifecycleAvailable,
  beginProviderCleanup,
  deactivateProviderDelegate,
  getStableBrowserTracer,
  initializeProviderLifecycleGlobals,
  settleProviderCleanup,
} from './providerLifecycle'
import { assertBrowserReplayUrl, createTelemetryUrlPatterns, isBrowserReplayUrlValid } from './telemetryUrls'
export { DiagLogLevel } from '@opentelemetry/api'
export * from 'logfire'
export { getBrowserSessionId } from './browserSession'
export type { BrowserSessionOptions, BrowserSessionUrlAttributes, RUMOptions } from './browserSession'
export type { BrowserMetricsOptions, BrowserWebVitalsMetricOptions } from './browserMetrics'
export type { BrowserSessionReplayOptions } from './sessionReplay'
export type { BrowserWebVitalsOptions } from './webVitals'

type TraceExporterConfig = NonNullable<typeof OTLPTraceExporter extends new (config: infer T) => unknown ? T : never>
export type BrowserInstrumentationInput = Instrumentation | Instrumentation[] | (() => Instrumentation | Instrumentation[])
export type AutoInstrumentationsConfig = WebAutoInstrumentationConfigMap & { enabled?: boolean }

export interface BrowserSessionReplayHandle {
  readonly mode: 'full' | 'buffer' | 'off'
  readonly recording: boolean
  flush(): Promise<void>
  stop(): Promise<void>
}

export interface BrowserConfigureHandle {
  (): Promise<void>
  readonly sessionReplay?: BrowserSessionReplayHandle
}

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
   * Lazily register OpenTelemetry browser auto-instrumentations after the
   * Logfire browser provider and session span processor are ready. Disabled by
   * default. Pass an object to configure `getWebAutoInstrumentations()`.
   */
  autoInstrumentations?: boolean | AutoInstrumentationsConfig
  /**
   * The instrumentations to register. Pass factories when construction should
   * happen after the Logfire browser provider is registered.
   */
  instrumentations?: BrowserInstrumentationInput[]
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

  assertBrowserReplayUrl(sessionReplay.replayUrl)
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

function flattenInstrumentations(instrumentations: Instrumentation | Instrumentation[]): Instrumentation[] {
  return Array.isArray(instrumentations) ? instrumentations : [instrumentations]
}

function resolveAutoInstrumentationsConfig(
  autoInstrumentations: LogfireConfigOptions['autoInstrumentations'],
  telemetryUrls: { metricUrl?: string | undefined; replayUrl?: string | undefined; traceUrl: string }
): WebAutoInstrumentationConfigMap | undefined {
  if (autoInstrumentations === undefined || autoInstrumentations === false) {
    return undefined
  }

  const config = autoInstrumentations === true ? {} : autoInstrumentations
  const { enabled, ...instrumentationConfig } = config
  if (enabled === false) {
    return undefined
  }

  const endpointPatterns = createTelemetryUrlPatterns([
    { kind: 'exact', url: telemetryUrls.traceUrl },
    ...(telemetryUrls.metricUrl === undefined ? [] : [{ kind: 'exact' as const, url: telemetryUrls.metricUrl }]),
    ...(telemetryUrls.replayUrl === undefined ? [] : [{ kind: 'replay-base' as const, url: telemetryUrls.replayUrl }]),
  ])
  const fetchKey = '@opentelemetry/instrumentation-fetch'
  const xhrKey = '@opentelemetry/instrumentation-xml-http-request'
  const fetchConfig = instrumentationConfig[fetchKey]
  const xhrConfig = instrumentationConfig[xhrKey]

  return {
    ...instrumentationConfig,
    [fetchKey]: {
      ...fetchConfig,
      ignoreUrls: [...(fetchConfig?.ignoreUrls ?? []), ...endpointPatterns],
    },
    [xhrKey]: {
      ...xhrConfig,
      ignoreUrls: [...(xhrConfig?.ignoreUrls ?? []), ...endpointPatterns],
    },
  }
}

function noopUnregister(): void {
  return undefined
}

function startBrowserInstrumentations(options: {
  autoInstrumentations: LogfireConfigOptions['autoInstrumentations']
  instrumentations: LogfireConfigOptions['instrumentations']
  telemetryUrls: { metricUrl?: string | undefined; replayUrl?: string | undefined; traceUrl: string }
  tracerProvider: WebTracerProvider
}): () => Promise<void> {
  const unregisterConfigured: (() => void)[] = []
  const configuredInputs = options.instrumentations ?? []
  const inputs = configuredInputs.length === 0 ? ([[]] as BrowserInstrumentationInput[]) : configuredInputs
  for (const input of inputs) {
    let instrumentations: Instrumentation[] = []
    try {
      instrumentations = flattenInstrumentations(typeof input === 'function' ? input() : input)
      unregisterConfigured.push(
        registerInstrumentations({
          instrumentations,
          tracerProvider: options.tracerProvider,
        })
      )
    } catch (error) {
      disableInstrumentations(instrumentations)
      diag.error('logfire-browser: failed to start configured browser instrumentation group', error)
    }
  }
  const autoInstrumentationsConfig = resolveAutoInstrumentationsConfig(options.autoInstrumentations, options.telemetryUrls)
  const unregisterAutoInstrumentationsPromise =
    autoInstrumentationsConfig === undefined
      ? undefined
      : import('@opentelemetry/auto-instrumentations-web')
          .then(({ getWebAutoInstrumentations }) => {
            const instrumentations = getWebAutoInstrumentations(autoInstrumentationsConfig)
            try {
              return registerInstrumentations({
                instrumentations,
                tracerProvider: options.tracerProvider,
              })
            } catch (error) {
              disableInstrumentations(instrumentations)
              throw error
            }
          })
          .catch((error: unknown) => {
            diag.error('logfire-browser: failed to start browser auto-instrumentations', error)
            return noopUnregister
          })

  let cleanupPromise: Promise<void> | undefined
  return async () => {
    cleanupPromise ??= (async () => {
      const unregisterAutoInstrumentations = await unregisterAutoInstrumentationsPromise
      const unregisters = [
        ...unregisterConfigured,
        ...(unregisterAutoInstrumentations === undefined ? [] : [unregisterAutoInstrumentations]),
      ]
      let firstError: unknown
      for (let index = unregisters.length - 1; index >= 0; index -= 1) {
        try {
          unregisters[index]?.()
        } catch (error) {
          firstError ??= error
        }
      }
      if (firstError !== undefined) {
        throw firstError instanceof Error
          ? firstError
          : new Error('logfire-browser: instrumentation unregister failed', { cause: firstError })
      }
    })()
    return cleanupPromise
  }
}

function disableInstrumentations(instrumentations: Instrumentation[]): void {
  for (let index = instrumentations.length - 1; index >= 0; index -= 1) {
    try {
      instrumentations[index]?.disable()
    } catch (error) {
      diag.error('logfire-browser: failed to disable browser instrumentation after registration failure', error)
    }
  }
}

function snapshotSharedLogfireApiConfig() {
  return {
    baggage: logfireApiConfig.baggage,
    enableErrorFingerprinting: logfireApiConfig.enableErrorFingerprinting,
    jsonSchema: logfireApiConfig.jsonSchema,
    minLevel: logfireApiConfig.minLevel,
    scrubber: logfireApiConfig.scrubber,
    tracer: logfireApiConfig.tracer,
  }
}

function restoreSharedLogfireApiConfig(snapshot: ReturnType<typeof snapshotSharedLogfireApiConfig>): void {
  logfireApiConfig.baggage = snapshot.baggage
  logfireApiConfig.enableErrorFingerprinting = snapshot.enableErrorFingerprinting
  logfireApiConfig.jsonSchema = snapshot.jsonSchema
  logfireApiConfig.minLevel = snapshot.minLevel
  logfireApiConfig.scrubber = snapshot.scrubber
  logfireApiConfig.tracer = snapshot.tracer
}

export function configure(options: LogfireConfigOptions): BrowserConfigureHandle {
  assertProviderLifecycleAvailable()

  const webVitalsOptions = resolveBrowserWebVitalsOptions(options.rum?.webVitals)
  const sessionReplayOptions = resolveBrowserSessionReplayOptions(options.sessionReplay)
  const browserMetricsOptions = resolveBrowserMetricsOptions(options.metrics)
  const webVitalsMetricOptions = resolveBrowserWebVitalsMetricOptions(webVitalsOptions)
  if (webVitalsMetricOptions !== undefined && browserMetricsOptions === undefined) {
    throw new Error('logfire-browser: rum.webVitals.metrics requires top-level metrics.metricUrl')
  }
  const browserSessionOptions = resolveBrowserSessionOptions(options.rum, sessionReplayOptions)
  initializeProviderLifecycleGlobals(options.contextManager)

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

  let tracerProvider: WebTracerProvider
  try {
    tracerProvider = new WebTracerProvider({
      idGenerator: new ULIDGenerator(),
      resource,
      ...(sampler ? { sampler } : {}),
      spanProcessors,
    })
  } catch (error) {
    if (browserSessionManager !== undefined) {
      clearConfiguredBrowserSession(browserSessionManager)
    }
    throw error
  }

  const sharedApiConfigSnapshot = snapshotSharedLogfireApiConfig()
  const generationToken = activateProviderGeneration(tracerProvider)
  try {
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
    if (options.diagLogLevel !== undefined) {
      diag.setLogger(new DiagConsoleLogger(), options.diagLogLevel)
    }
    logfireApiConfig.tracer = getStableBrowserTracer(logfireApiConfig.otelScope)
  } catch (error) {
    beginProviderCleanup(generationToken)
    deactivateProviderDelegate(generationToken)
    restoreSharedLogfireApiConfig(sharedApiConfigSnapshot)
    let rollbackError: Error | undefined
    if (browserSessionManager !== undefined) {
      try {
        clearConfiguredBrowserSession(browserSessionManager)
      } catch (sessionError) {
        rollbackError = sessionError instanceof Error ? sessionError : new Error(String(sessionError))
      }
    }
    tracerProvider.shutdown().then(
      () => {
        settleProviderCleanup(generationToken, rollbackError)
      },
      (shutdownError: unknown) => {
        settleProviderCleanup(
          generationToken,
          rollbackError ?? (shutdownError instanceof Error ? shutdownError : new Error(String(shutdownError)))
        )
      }
    )
    throw error
  }

  const unregisterInstrumentations = startBrowserInstrumentations({
    autoInstrumentations: options.autoInstrumentations,
    instrumentations: options.instrumentations,
    telemetryUrls: {
      metricUrl: browserMetricsOptions?.metricUrl,
      replayUrl:
        sessionReplayOptions !== undefined && isBrowserReplayUrlValid(sessionReplayOptions.replayUrl)
          ? sessionReplayOptions.replayUrl
          : undefined,
      traceUrl: options.traceUrl,
    },
    tracerProvider,
  })

  let readySessionReplay: BrowserSessionReplayControl | undefined
  const sessionReplayStartupPromise =
    sessionReplayOptions === undefined || browserSessionManager === undefined
      ? undefined
      : startBrowserSessionReplay(sessionReplayOptions, browserSessionManager, browserSessionReplayState, {
          metricUrl: browserMetricsOptions?.metricUrl,
          traceUrl: options.traceUrl,
        }).then((sessionReplay) => {
          readySessionReplay = sessionReplay
          return sessionReplay
        })

  let replayOperationTail = Promise.resolve()
  let replayStopPromise: Promise<void> | undefined
  let replayStopped = false
  const sessionReplayHandle: BrowserSessionReplayHandle | undefined =
    sessionReplayStartupPromise === undefined
      ? undefined
      : {
          get mode() {
            return replayStopped ? 'off' : (readySessionReplay?.mode ?? 'off')
          },
          get recording() {
            return replayStopped ? false : (readySessionReplay?.recording ?? false)
          },
          // Return stored promises directly so stop/full-cleanup calls preserve identity.
          // eslint-disable-next-line @typescript-eslint/promise-function-async
          flush() {
            if (replayStopped) {
              return replayStopPromise ?? replayOperationTail
            }
            const flushPromise = replayOperationTail.then(async () => {
              const sessionReplay = await sessionReplayStartupPromise
              await sessionReplay?.flush()
            })
            replayOperationTail = flushPromise
            return flushPromise
          },
          // eslint-disable-next-line @typescript-eslint/promise-function-async
          stop() {
            if (replayStopPromise !== undefined) {
              return replayStopPromise
            }
            replayStopped = true
            browserSessionReplayState.clear()
            replayStopPromise = replayOperationTail.then(async () => {
              const sessionReplay = await sessionReplayStartupPromise
              await sessionReplay?.stop()
            })
            replayOperationTail = replayStopPromise
            return replayStopPromise
          },
        }

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
        ? startBrowserWebVitals({
            ...webVitalsOptions,
            tracer: tracerProvider.getTracer('logfire-web-vitals'),
          }).catch((error: unknown) => {
            diag.error('logfire-browser: failed to start Web Vitals reporting', error)
            return undefined
          })
        : (async () => {
            const browserMetrics = await browserMetricsStartupPromise
            if (browserMetrics === undefined) {
              diag.warn('logfire-browser: browser metrics did not start; continuing Web Vitals with span reporting only')
              return startBrowserWebVitals({
                ...webVitalsOptions,
                tracer: tracerProvider.getTracer('logfire-web-vitals'),
              })
            }

            return startBrowserWebVitals({
              ...webVitalsOptions,
              metricRecorder: browserMetrics.createWebVitalsMetricRecorder(webVitalsMetricOptions),
              tracer: tracerProvider.getTracer('logfire-web-vitals'),
            })
          })().catch((error: unknown) => {
            diag.error('logfire-browser: failed to start Web Vitals reporting', error)
            return undefined
          })

  let cleanupPromise: Promise<void> | undefined

  // Return the stored promise directly so repeated cleanup calls preserve identity.
  // eslint-disable-next-line @typescript-eslint/promise-function-async
  const cleanup: BrowserConfigureHandle = () => {
    if (cleanupPromise !== undefined) {
      return cleanupPromise
    }

    beginProviderCleanup(generationToken)
    cleanupPromise = (async () => {
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
      if (sessionReplayHandle !== undefined) {
        await runCleanupStep('session replay shutdown', async () => sessionReplayHandle.stop())
      }
      await runCleanupStep('instrumentation unregister', unregisterInstrumentations)
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
      deactivateProviderDelegate(generationToken)
      await runCleanupStep('force flush', async () => tracerProvider.forceFlush())
      await runCleanupStep('tracer provider shutdown', async () => tracerProvider.shutdown())
      if (browserSessionManager !== undefined) {
        await runCleanupStep('browser session cleanup', () => {
          clearConfiguredBrowserSession(browserSessionManager)
        })
      }

      const cleanupError = firstCleanupError === undefined ? undefined : new Error(firstCleanupError.message, { cause: firstCleanupError })
      settleProviderCleanup(generationToken, cleanupError)
      if (cleanupError !== undefined) {
        throw cleanupError
      }

      diag.info('logfire-browser: shut down complete')
    })()

    return cleanupPromise
  }
  if (sessionReplayHandle !== undefined) {
    Object.defineProperty(cleanup, 'sessionReplay', {
      enumerable: true,
      value: sessionReplayHandle,
    })
  }
  return cleanup
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
