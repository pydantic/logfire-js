/* eslint-disable perfectionist/sort-objects */
import { context as ContextAPI, Span, SpanStatusCode, trace as TraceAPI } from '@opentelemetry/api'
import { ATTR_EXCEPTION_MESSAGE, ATTR_EXCEPTION_STACKTRACE } from '@opentelemetry/semantic-conventions'

export * from './AttributeScrubber'
export { serializeAttributes } from './serializeAttributes'

const DEFAULT_OTEL_SCOPE = 'logfire'

export interface LogOptions {
  tags?: string[]
}

export interface LogfireApiConfigOptions {
  otelScope?: string
}

export const Level = {
  Trace: 1 as const,
  Debug: 5 as const,
  Info: 9 as const,
  Notice: 10 as const,
  Warning: 13 as const,
  Error: 17 as const,
  Fatal: 21 as const,
}

export type LogFireLevel = (typeof Level)[keyof typeof Level]

const LOGFIRE_ATTRIBUTES_NAMESPACE = 'logfire'
const ATTRIBUTES_LEVEL_KEY = `${LOGFIRE_ATTRIBUTES_NAMESPACE}.level_num`
export const ATTRIBUTES_TAGS_KEY = `${LOGFIRE_ATTRIBUTES_NAMESPACE}.tags`

const currentLogfireApiConfig: LogfireApiConfigOptions = {}

export function configureLogfireApi(config: LogfireApiConfigOptions) {
  Object.assign(currentLogfireApiConfig, {
    ...config,
  })
}

const logfireApiConfig = {
  get context() {
    return ContextAPI.active()
  },

  get otelScope() {
    return currentLogfireApiConfig.otelScope ?? DEFAULT_OTEL_SCOPE
  },

  get tracer() {
    return TraceAPI.getTracer(logfireApiConfig.otelScope)
  },
}

function startSpan(level: LogFireLevel, message: string, attributes: Record<string, unknown> = {}, { tags = [] }: LogOptions = {}): Span {
  const span = logfireApiConfig.tracer.startSpan(
    message,
    {
      attributes: {
        ...attributes,
        [ATTRIBUTES_LEVEL_KEY]: level,
        [ATTRIBUTES_TAGS_KEY]: Array.from(new Set(tags).values()),
      },
    },
    logfireApiConfig.context
  )

  return span
}

export function startActiveSpan<F extends (span: Span) => unknown>(
  level: LogFireLevel,
  message: string,
  attributes: Record<string, unknown> = {},
  { tags = [] }: LogOptions = {},
  callback: F
) {
  return logfireApiConfig.tracer.startActiveSpan<F>(
    message,
    {
      attributes: {
        ...attributes,
        [ATTRIBUTES_LEVEL_KEY]: level,
        [ATTRIBUTES_TAGS_KEY]: Array.from(new Set(tags).values()),
      },
    },
    callback
  )
}

export function log(level: LogFireLevel, message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}) {
  startSpan(level, message, attributes, options).end()
}

export function debug(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}) {
  log(Level.Debug, message, attributes, options)
}

export function info(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}) {
  log(Level.Info, message, attributes, options)
}

export function trace(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}) {
  log(Level.Trace, message, attributes, options)
}

export function error(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}) {
  log(Level.Error, message, attributes, options)
}

export function fatal(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}) {
  log(Level.Fatal, message, attributes, options)
}

export function notice(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}) {
  log(Level.Notice, message, attributes, options)
}

export function warning(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}) {
  log(Level.Warning, message, attributes, options)
}

export function reportError(message: string, error: Error, extraAttributes: Record<string, unknown> = {}) {
  const span = startSpan(Level.Error, message, {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    [ATTR_EXCEPTION_MESSAGE]: error.message ?? 'error',
    [ATTR_EXCEPTION_STACKTRACE]: error.stack,
    ...extraAttributes,
  })

  span.recordException(error)
  span.setStatus({ code: SpanStatusCode.ERROR })
  span.end()
}
