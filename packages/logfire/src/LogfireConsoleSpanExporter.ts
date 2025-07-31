import { ExportResult, ExportResultCode, hrTimeToMicroseconds } from '@opentelemetry/core'
import { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import pc from 'picocolors'

const LevelLabels = {
  1: 'trace',
  5: 'debug',
  9: 'info',
  10: 'notice',
  13: 'warning',
  17: 'error',
  21: 'fatal',
} as const

const ColorMap = {
  debug: pc.blue,
  error: pc.red,
  fatal: pc.magenta,
  info: pc.cyan,
  notice: pc.green,
  trace: pc.gray,
  warning: pc.yellow,
}

export class LogfireConsoleSpanExporter implements SpanExporter {
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
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      const type = LevelLabels[span.attributes['logfire.level_num'] as keyof typeof LevelLabels] ?? 'info'

      const { attributes, name, ...rest } = this.exportInfo(span)
      console.log(`${pc.bgMagentaBright('Logfire')} ${ColorMap[type](type)} ${name}`)
      console.dir(attributes)
      console.dir(rest)
    }
    if (done) {
      done({ code: ExportResultCode.SUCCESS })
    }
  }
}
