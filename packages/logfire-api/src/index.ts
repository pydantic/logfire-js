/* eslint-disable perfectionist/sort-objects */
import { Span, SpanStatusCode } from '@opentelemetry/api'
import { ATTR_EXCEPTION_MESSAGE, ATTR_EXCEPTION_STACKTRACE } from '@opentelemetry/semantic-conventions'

import { ATTRIBUTES_LEVEL_KEY, ATTRIBUTES_MESSAGE_TEMPLATE_KEY, ATTRIBUTES_SPAN_TYPE_KEY, ATTRIBUTES_TAGS_KEY } from './constants'
import { logfireFormatWithExtras } from './formatter'
import { logfireApiConfig, ScrubbingOptions, serializeAttributes } from './logfireApiConfig'

export * from './AttributeScrubber'
export { configureLogfireApi, logfireApiConfig, resolveBaseUrl, resolveSendToLogfire } from './logfireApiConfig'
export type { ScrubbingOptions } from './logfireApiConfig'
export { serializeAttributes } from './serializeAttributes'
export * from './ULIDGenerator'

export interface LogfireApiConfigOptions {
  otelScope?: string
  /**
   * Options for scrubbing sensitive data. Set to False to disable.
   */
  scrubbing?: false | ScrubbingOptions
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

export interface LogOptions {
  level?: LogFireLevel
  log?: true
  tags?: string[]
}

/**
 * Starts a new Span without setting it on context.
 * This method does NOT modify the current Context.
 * You need to manually call `span.end()` to finish the span.
 */
export function startSpan(
  msgTemplate: string,
  attributes: Record<string, unknown> = {},
  { log, tags = [], level = Level.Info }: LogOptions = {}
): Span {
  const [formattedMessage, extraAttributes, newTemplate] = logfireFormatWithExtras(msgTemplate, attributes, logfireApiConfig.scrubber)
  const span = logfireApiConfig.tracer.startSpan(
    formattedMessage,
    {
      attributes: {
        ...serializeAttributes({ ...attributes, ...extraAttributes }),
        [ATTRIBUTES_MESSAGE_TEMPLATE_KEY]: newTemplate,
        [ATTRIBUTES_LEVEL_KEY]: level,
        [ATTRIBUTES_TAGS_KEY]: Array.from(new Set(tags).values()),
        [ATTRIBUTES_SPAN_TYPE_KEY]: log ? 'log' : 'span',
      },
    },
    logfireApiConfig.context
  )

  return span
}

/**
 * Starts a new Span and calls the given function passing it the
 * created span as first argument.
 * Additionally the new span gets set in context and this context is activated within the execution of the function.
 * The span will be ended automatically after the function call.
 */
export function span<R>(
  msgTemplate: string,
  attributes: Record<string, unknown> = {},
  { tags = [], level = Level.Info }: LogOptions = {},
  callback: (span: Span) => R
) {
  const [formattedMessage, extraAttributes, newTemplate] = logfireFormatWithExtras(msgTemplate, attributes, logfireApiConfig.scrubber)

  return logfireApiConfig.tracer.startActiveSpan(
    formattedMessage,
    {
      attributes: {
        ...serializeAttributes({ ...attributes, ...extraAttributes }),
        [ATTRIBUTES_MESSAGE_TEMPLATE_KEY]: newTemplate,
        [ATTRIBUTES_LEVEL_KEY]: level,
        [ATTRIBUTES_TAGS_KEY]: Array.from(new Set(tags).values()),
      },
    },
    (span: Span) => {
      const result = callback(span)

      const asPromise = Promise.resolve(result)
      if (asPromise === result) {
        // eslint-disable-next-line no-void
        void asPromise.finally(() => {
          span.end()
        })
      } else {
        span.end()
      }
      return result
    }
  )
}

export function log(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}) {
  startSpan(message, attributes, { ...options, log: true }).end()
}

export function debug(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}) {
  log(message, attributes, { ...options, level: Level.Debug })
}

export function info(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}) {
  log(message, attributes, { ...options, level: Level.Info })
}

export function trace(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}) {
  log(message, attributes, { ...options, level: Level.Trace })
}

export function error(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}) {
  log(message, attributes, { ...options, level: Level.Error })
}

export function fatal(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}) {
  log(message, attributes, { ...options, level: Level.Fatal })
}

export function notice(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}) {
  log(message, attributes, { ...options, level: Level.Notice })
}

export function warning(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}) {
  log(message, attributes, { ...options, level: Level.Warning })
}

/**
 * Use this method to report an error to Logfire.
 * Captures the error stack trace and message in the respective semantic attributes and sets the correct level and status.
 */
export function reportError(message: string, error: Error, extraAttributes: Record<string, unknown> = {}) {
  const span = startSpan(
    message,
    {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      [ATTR_EXCEPTION_MESSAGE]: error.message ?? 'error',
      [ATTR_EXCEPTION_STACKTRACE]: error.stack,
      ...extraAttributes,
    },
    {
      level: Level.Error,
    }
  )

  span.recordException(error)
  span.setStatus({ code: SpanStatusCode.ERROR })
  span.end()
}
