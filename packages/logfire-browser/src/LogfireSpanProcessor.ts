/* eslint-disable @typescript-eslint/no-unnecessary-condition */
/* eslint-disable @typescript-eslint/no-deprecated */
import { Context } from '@opentelemetry/api'
import { ExportResult, ExportResultCode, hrTimeToMicroseconds } from '@opentelemetry/core'
import { ReadableSpan, SimpleSpanProcessor, Span, SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace-web'
import { ATTR_HTTP_URL } from '@opentelemetry/semantic-conventions/incubating'

// not present in the semantic conventions
const ATTR_TARGET_XPATH = 'target_xpath'
const ATTR_EVENT_TYPE = 'event_type'

export const LevelLabels = {
  1: 'trace',
  5: 'debug',
  9: 'info',
  10: 'notice',
  13: 'warning',
  17: 'error',
  21: 'fatal',
} as const

const Colors = {
  debug: '#E3E3E3',
  error: '#EA4335',
  fatal: '#EA4335',
  info: '#9EC1FB',
  notice: '#A5D490',
  'on-debug': '#636262',
  'on-error': '#FFEDE9',
  'on-fatal': '#FFEDE9',
  'on-info': '#063175',
  'on-notice': '#222222',
  'on-trace': '#636262',
  'on-warning': '#613A0D',
  trace: '#E3E3E3',
  warning: '#EFB77A',
} as const

class LogfireConsoleSpanExporter implements SpanExporter {
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.sendSpans(spans, resultCallback)
  }

  forceFlush(): Promise<void> {
    return Promise.resolve()
  }
  shutdown(): Promise<void> {
    this.sendSpans([])
    return this.forceFlush()
  }
  /**
   * converts span info into more readable format
   * @param span
   */
  private exportInfo(span: ReadableSpan) {
    return {
      attributes: span.attributes,
      duration: hrTimeToMicroseconds(span.duration),
      events: span.events,
      id: span.spanContext().spanId,
      instrumentationScope: span.instrumentationScope,
      kind: span.kind,
      links: span.links,
      name: span.name,
      parentSpanContext: span.parentSpanContext,
      resource: {
        attributes: span.resource.attributes,
      },
      status: span.status,
      timestamp: hrTimeToMicroseconds(span.startTime),
      traceId: span.spanContext().traceId,
      traceState: span.spanContext().traceState?.serialize(),
    }
  }

  private sendSpans(spans: ReadableSpan[], done?: (result: ExportResult) => void): void {
    for (const span of spans) {
      const type = LevelLabels[span.attributes['logfire.level_num'] as keyof typeof LevelLabels] ?? 'info'

      const { attributes, name, ...rest } = this.exportInfo(span)
      console.log(
        `%cLogfire %c${type}`,
        'background-color: #E520E9; color: #FFFFFF',
        `background-color: ${Colors[`on-${type}`]}; color: ${Colors[type]}`,
        name,
        attributes,
        rest
      )
    }
    if (done) {
      done({ code: ExportResultCode.SUCCESS })
    }
  }
}

export class LogfireSpanProcessor implements SpanProcessor {
  private console?: SpanProcessor
  private wrapped: SpanProcessor

  constructor(wrapped: SpanProcessor, enableConsole: boolean) {
    if (enableConsole) {
      this.console = new SimpleSpanProcessor(new LogfireConsoleSpanExporter())
    }
    this.wrapped = wrapped
  }

  async forceFlush(): Promise<void> {
    await this.console?.forceFlush()
    return this.wrapped.forceFlush()
  }

  onEnd(span: ReadableSpan): void {
    this.console?.onEnd(span)
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
    this.console?.onStart(span, parentContext)
    this.wrapped.onStart(span, parentContext)
  }

  async shutdown(): Promise<void> {
    await this.console?.shutdown()
    return this.wrapped.shutdown()
  }
}
