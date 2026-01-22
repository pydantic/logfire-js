/* eslint-disable perfectionist/sort-objects */
import { Span, SpanStatusCode, context as TheContextAPI, trace as TheTraceAPI } from '@opentelemetry/api'
import { ATTR_EXCEPTION_MESSAGE, ATTR_EXCEPTION_STACKTRACE } from '@opentelemetry/semantic-conventions'

import * as AttributeScrubbingExports from './AttributeScrubber'
import {
  ATTRIBUTES_EXCEPTION_FINGERPRINT_KEY,
  ATTRIBUTES_LEVEL_KEY,
  ATTRIBUTES_MESSAGE_KEY,
  ATTRIBUTES_MESSAGE_TEMPLATE_KEY,
  ATTRIBUTES_SPAN_TYPE_KEY,
  ATTRIBUTES_TAGS_KEY,
} from './constants'
import * as fingerprintExports from './fingerprint'
import { computeFingerprint } from './fingerprint'
import { logfireFormatWithExtras } from './formatter'
import { logfireApiConfig, serializeAttributes } from './logfireApiConfig'
import * as logfireApiConfigExports from './logfireApiConfig'
import * as ULIDGeneratorExports from './ULIDGenerator'

export * from './AttributeScrubber'
export { canonicalizeError, computeFingerprint } from './fingerprint'
export { configureLogfireApi, logfireApiConfig, resolveBaseUrl, resolveSendToLogfire } from './logfireApiConfig'
export type { LogfireApiConfig, LogfireApiConfigOptions, ScrubbingOptions } from './logfireApiConfig'
export { serializeAttributes } from './serializeAttributes'
export * from './ULIDGenerator'

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
  /**
   * The log level for the span.
   * Defaults to Level.Info.
   */
  level?: LogFireLevel
  /**
   * Set to true to indicate that this span is a log. logs don't have child spans.
   */
  log?: true
  /**
   * Set a span started with `startSpan` as parentSpan to create a child span.
   */
  parentSpan?: Span
  /**
   * Tags to add to the span.
   */
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
  { log, tags = [], level = Level.Info, parentSpan }: LogOptions = {}
): Span {
  const { formattedMessage, extraAttributes, newTemplate } = logfireFormatWithExtras(msgTemplate, attributes, logfireApiConfig.scrubber)

  const context = parentSpan ? TheTraceAPI.setSpan(TheContextAPI.active(), parentSpan) : TheContextAPI.active()
  const span = logfireApiConfig.tracer.startSpan(
    msgTemplate,
    {
      attributes: {
        ...serializeAttributes({ ...attributes, ...extraAttributes }),
        [ATTRIBUTES_MESSAGE_TEMPLATE_KEY]: newTemplate,
        [ATTRIBUTES_MESSAGE_KEY]: formattedMessage,
        [ATTRIBUTES_LEVEL_KEY]: level,
        [ATTRIBUTES_TAGS_KEY]: Array.from(new Set(tags).values()),
        [ATTRIBUTES_SPAN_TYPE_KEY]: log ? 'log' : 'span',
      },
    },
    context
  )

  return span
}

type SpanCallback<R> = (activeSpan: Span) => R
type SpanArgsVariant1<R> = [Record<string, unknown>, LogOptions, SpanCallback<R>]
type SpanArgsVariant2<R> = [
  { attributes?: Record<string, unknown>; callback: SpanCallback<R>; level?: LogFireLevel; parentSpan?: Span; tags?: string[] },
]

/**
 * Starts a new Span and calls the given function passing it the
 * created span as first argument.
 * Additionally the new span gets set in context and this context is activated within the execution of the function.
 * The span will be ended automatically after the function call.
 */
export function span<R>(msgTemplate: string, options: SpanArgsVariant2<R>[0]): R
// eslint-disable-next-line no-redeclare
export function span<R>(msgTemplate: string, attributes: Record<string, unknown>, options: LogOptions, callback: (span: Span) => R): R
// eslint-disable-next-line no-redeclare
export function span<R>(msgTemplate: string, ...args: SpanArgsVariant1<R> | SpanArgsVariant2<R>): R {
  let attributes: Record<string, unknown> = {}
  let level: LogFireLevel = Level.Info
  let tags: string[] = []
  let callback!: SpanCallback<R>
  let parentSpan: Span | undefined
  if (args.length === 1) {
    attributes = args[0].attributes ?? {}
    level = args[0].level ?? Level.Info
    tags = args[0].tags ?? []
    callback = args[0].callback
    parentSpan = args[0].parentSpan
  } else {
    attributes = args[0]
    level = args[1].level ?? Level.Info
    tags = args[1].tags ?? []
    parentSpan = args[1].parentSpan
    callback = args[2]
  }

  const { formattedMessage, extraAttributes, newTemplate } = logfireFormatWithExtras(msgTemplate, attributes, logfireApiConfig.scrubber)

  const context = parentSpan ? TheTraceAPI.setSpan(TheContextAPI.active(), parentSpan) : TheContextAPI.active()
  return logfireApiConfig.tracer.startActiveSpan(
    msgTemplate,
    {
      attributes: {
        ...serializeAttributes({ ...attributes, ...extraAttributes }),
        [ATTRIBUTES_MESSAGE_TEMPLATE_KEY]: newTemplate,
        [ATTRIBUTES_MESSAGE_KEY]: formattedMessage,
        [ATTRIBUTES_LEVEL_KEY]: level,
        [ATTRIBUTES_TAGS_KEY]: Array.from(new Set(tags).values()),
      },
    },
    context,
    (span: Span) => {
      const result = callback(span)

      // we need this clunky detection because of zone.js promises
      if (typeof result === 'object' && result !== null && 'finally' in result && typeof result.finally === 'function') {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        result.finally(() => {
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
 * Computes a fingerprint for the error to enable issue grouping in the Logfire backend.
 */
export function reportError(message: string, error: Error, extraAttributes: Record<string, unknown> = {}) {
  const fingerprint = computeFingerprint(error)

  const span = startSpan(
    message,
    {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      [ATTR_EXCEPTION_MESSAGE]: error.message ?? 'error',
      [ATTR_EXCEPTION_STACKTRACE]: error.stack,
      [ATTRIBUTES_EXCEPTION_FINGERPRINT_KEY]: fingerprint,
      ...extraAttributes,
    },
    {
      level: Level.Error,
    }
  )

  span.recordException(error)
  span.setStatus({ code: SpanStatusCode.ERROR, message: `${error.name}: ${error.message}` })
  span.end()
}

const defaultExport = {
  ...AttributeScrubbingExports,
  ...fingerprintExports,
  ...ULIDGeneratorExports,
  ...logfireApiConfigExports,

  serializeAttributes,
  Level,
  startSpan,
  span,
  log,
  debug,
  info,
  trace,
  error,
  fatal,
  notice,
  warning,
  reportError,
}

export default defaultExport
