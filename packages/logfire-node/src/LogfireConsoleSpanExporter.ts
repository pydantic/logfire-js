import type { ExportResult } from '@opentelemetry/core'
import { ExportResultCode, hrTimeToMicroseconds } from '@opentelemetry/core'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import { Level } from 'logfire'
import pc from 'picocolors'

import type { ResolvedConsoleOptions } from './consoleOptions'

const ATTRIBUTES_LEVEL_KEY = 'logfire.level_num'
const ATTRIBUTES_TAGS_KEY = 'logfire.tags'

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

const DEFAULT_OPTIONS = {
  enabled: true,
  includeTags: true,
  includeTimestamps: true,
  minLevel: Level.Info,
} satisfies ResolvedConsoleOptions

export class LogfireConsoleSpanExporter implements SpanExporter {
  private readonly options: ResolvedConsoleOptions

  constructor(options: ResolvedConsoleOptions = DEFAULT_OPTIONS) {
    this.options = options
  }

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
      const { level, type } = this.getSpanLevel(span)
      if (level < this.options.minLevel) {
        continue
      }

      const { attributes, name, ...rest } = this.exportInfo(span)
      console.log(`${pc.bgMagentaBright('Logfire')} ${ColorMap[type](type)} ${name}`)
      console.dir(this.printedAttributes(attributes))
      console.dir(this.printedMetadata(rest))
    }
    if (done) {
      done({ code: ExportResultCode.SUCCESS })
    }
  }

  private getSpanLevel(span: ReadableSpan): {
    level: (typeof Level)[keyof typeof Level]
    type: (typeof LevelLabels)[keyof typeof LevelLabels]
  } {
    const level = span.attributes[ATTRIBUTES_LEVEL_KEY]
    if (typeof level === 'number' && Object.hasOwn(LevelLabels, level)) {
      return {
        level: level as (typeof Level)[keyof typeof Level],
        type: LevelLabels[level as keyof typeof LevelLabels],
      }
    }
    return {
      level: Level.Info,
      type: 'info',
    }
  }

  private printedAttributes(attributes: ReadableSpan['attributes']): ReadableSpan['attributes'] {
    if (this.options.includeTags) {
      return attributes
    }

    const { [ATTRIBUTES_TAGS_KEY]: _tags, ...rest } = attributes
    return rest
  }

  private printedMetadata<T extends { timestamp: number }>(metadata: T): Omit<T, 'timestamp'> | T {
    if (this.options.includeTimestamps) {
      return metadata
    }

    const { timestamp: _timestamp, ...rest } = metadata
    return rest
  }
}
