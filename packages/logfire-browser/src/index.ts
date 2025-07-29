/* eslint-disable @typescript-eslint/no-deprecated */
import { Context, diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api'
import { ZoneContextManager } from '@opentelemetry/context-zone'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { Instrumentation, registerInstrumentations } from '@opentelemetry/instrumentation'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor, BufferConfig, ReadableSpan, Span, SpanProcessor, WebTracerProvider } from '@opentelemetry/sdk-trace-web'
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
  ATTR_HTTP_URL,
} from '@opentelemetry/semantic-conventions/incubating'
import { ULIDGenerator } from '@pydantic/logfire-api'
import * as logfireApi from '@pydantic/logfire-api'

import { OTLPTraceExporterWithDynamicHeaders } from './OTLPTraceExporterWithDynamicHeaders'
export { DiagLogLevel } from '@opentelemetry/api'
export * from '@pydantic/logfire-api'

type TraceExporterConfig = NonNullable<typeof OTLPTraceExporter extends new (config: infer T) => unknown ? T : never>

// not present in the semantic conventions
const ATTR_TARGET_XPATH = 'target_xpath'
const ATTR_EVENT_TYPE = 'event_type'

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
  scrubbing?: false | logfireApi.ScrubbingOptions

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
    logfireApi.configureLogfireApi({ scrubbing: options.scrubbing })
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
        )
      ),
    ],
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

class LogfireSpanProcessor implements SpanProcessor {
  private wrapped: SpanProcessor

  constructor(wrapped: SpanProcessor) {
    this.wrapped = wrapped
  }

  async forceFlush(): Promise<void> {
    return this.wrapped.forceFlush()
  }

  onEnd(span: ReadableSpan): void {
    // Note: this is too late for the regular node instrumentation. The opentelemetry API rejects the non-primitive attribute values.
    // Instead, the serialization happens at the `logfire.span, logfire.startSpan`, etc.
    // Object.assign(span.attributes, serializeAttributes(span.attributes))
    this.wrapped.onEnd(span)
  }

  onStart(span: Span, parentContext: Context): void {
    // make the fetch spans more descriptive
    if (ATTR_HTTP_URL in span.attributes) {
      const url = new URL(span.attributes[ATTR_HTTP_URL] as string)
      Reflect.set(span, 'name', `${span.name} ${url.pathname}`)
    }

    // same for the interaction spans
    if (ATTR_TARGET_XPATH in span.attributes) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      Reflect.set(span, 'name', `${span.attributes[ATTR_EVENT_TYPE] ?? 'unknown'} ${span.attributes[ATTR_TARGET_XPATH] ?? ''}`)
    }
    this.wrapped.onStart(span, parentContext)
  }

  async shutdown(): Promise<void> {
    return this.wrapped.shutdown()
  }
}
