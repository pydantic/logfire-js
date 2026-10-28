/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import type { Context } from '@opentelemetry/api'
import type { ExportResult } from '@opentelemetry/core'
import { ExportResultCode, hrTimeToMicroseconds } from '@opentelemetry/core'
import type { ReadableSpan, Span, SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace-web'
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-web'
import { ATTR_URL_FULL } from '@opentelemetry/semantic-conventions'
import { ATTR_HTTP_URL } from '@opentelemetry/semantic-conventions/incubating'
import { scrubSpanForExport } from 'logfire'

// not present in the semantic conventions
const ATTR_TARGET_XPATH = 'target_xpath'
const ATTR_EVENT_TYPE = 'event_type'

// URL and route attributes the browser SDK sets itself. Like the core `url.full`, `http.url`, and
// `http.route` safe keys, they are governed by the URL policy (`captureUrlQueryAndFragment`), so a
// path such as `/auth/login` or a kept query parameter named `secret` does not redact them.
const BROWSER_URL_ATTRIBUTES = new Set([
  'browser.long_animation_frame.script.source_url',
  'http.referrer',
  'logfire.page.route',
  'logfire.page.url.full',
  'logfire.page.url.path',
  'web_vital.inp.script.source_url',
  'web_vital.lcp.url',
])
const MAIN_THREAD_WINDOW_SCRIPT_URL_PATTERN = /^browser\.main_thread_window\.script\.\d+\.source_url$/u

/**
 * BrowserSessionSpanProcessor sets the session keys from the SDK's own session state; their names
 * contain `session`, which the default patterns would otherwise redact on every span.
 */
function isBrowserSafeAttribute(key: string): boolean {
  return (
    key === 'session.id' ||
    key.startsWith('logfire.session_replay.') ||
    BROWSER_URL_ATTRIBUTES.has(key) ||
    MAIN_THREAD_WINDOW_SCRIPT_URL_PATTERN.test(key)
  )
}

// Application session attributes from `getSessionAttributes()`. Their values are still scrubbed,
// but only the application's own name is matched, not the `session` in the prefix.
const BROWSER_SESSION_ATTRIBUTE_PREFIXES = ['logfire.session.']

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

  async forceFlush(): Promise<void> {
    return Promise.resolve()
  }
  async shutdown(): Promise<void> {
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

/**
 * `onStart` runs for every span, so a URL attribute that is not an absolute URL must not throw out of
 * it and break the caller's span creation. Anything unparseable just leaves the name as it was.
 */
function urlPathname(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  try {
    return new URL(value).pathname
  } catch {
    return undefined
  }
}

export class LogfireSpanProcessor implements SpanProcessor {
  private readonly console?: SpanProcessor
  private readonly wrapped: SpanProcessor

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
    // Serialization has to happen when `logfire.span` and friends create the span, because the
    // OpenTelemetry API rejects non-primitive attribute values. Scrubbing primitives here also covers
    // instrumentation spans, attributes set after creation, events, and links.
    scrubSpanForExport(span, { isSafeKey: isBrowserSafeAttribute, namespacePrefixes: BROWSER_SESSION_ATTRIBUTE_PREFIXES })
    this.console?.onEnd(span)
    this.wrapped.onEnd(span)
  }

  onStart(span: Span, parentContext: Context): void {
    // make the fetch spans more descriptive. The fetch and XHR instrumentations emit `url.full` since
    // 0.221; older versions emit `http.url`.
    const pathname = urlPathname(span.attributes[ATTR_URL_FULL] ?? span.attributes[ATTR_HTTP_URL])
    if (pathname !== undefined) {
      Reflect.set(span, 'name', `${span.name} ${pathname}`)
    }

    // same for the interaction spans
    if (ATTR_TARGET_XPATH in span.attributes) {
      const eventType = String(span.attributes[ATTR_EVENT_TYPE] ?? 'unknown')
      const targetXPath = String(span.attributes[ATTR_TARGET_XPATH] ?? '')
      Reflect.set(span, 'name', `${eventType} ${targetXPath}`)
    }
    this.console?.onStart(span, parentContext)
    this.wrapped.onStart(span, parentContext)
  }

  async shutdown(): Promise<void> {
    await this.console?.shutdown()
    return this.wrapped.shutdown()
  }
}
