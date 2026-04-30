import type { Span } from '@opentelemetry/api'
import { SpanStatusCode, context as TheContextAPI, trace as TheTraceAPI } from '@opentelemetry/api'
import { ATTR_EXCEPTION_MESSAGE, ATTR_EXCEPTION_STACKTRACE } from '@opentelemetry/semantic-conventions'

import { LogfireAttributeScrubber, NoopAttributeScrubber, NoopScrubber } from './AttributeScrubber'
import {
  ATTRIBUTES_EXCEPTION_FINGERPRINT_KEY,
  ATTRIBUTES_LEVEL_KEY,
  ATTRIBUTES_MESSAGE_KEY,
  ATTRIBUTES_MESSAGE_TEMPLATE_KEY,
  ATTRIBUTES_SPAN_TYPE_KEY,
  ATTRIBUTES_TAGS_KEY,
} from './constants'
import { canonicalizeError, computeFingerprint } from './fingerprint'
import { logfireFormatWithExtras } from './formatter'
import { configureLogfireApi, logfireApiConfig, resolveBaseUrl, resolveSendToLogfire, serializeAttributes } from './logfireApiConfig'
import { SpanLevel, checkTraceIdRatio, levelOrDuration } from './sampling'
import { TailSamplingProcessor } from './TailSamplingProcessor'
import { ULIDGenerator } from './ULIDGenerator'

export * from './AttributeScrubber'
export { canonicalizeError, computeFingerprint } from './fingerprint'
export { configureLogfireApi, logfireApiConfig, resolveBaseUrl, resolveSendToLogfire } from './logfireApiConfig'
export type { LogfireApiConfig, LogfireApiConfigOptions, ScrubbingOptions } from './logfireApiConfig'
export * from './sampling'
export { serializeAttributes } from './serializeAttributes'
export { TailSamplingProcessor } from './TailSamplingProcessor'
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
   * Override the OTel span name without changing the message template stored on
   * `logfire.msg_template`. Used by integrations (e.g. evals) that want a stable,
   * un-interpolated span name for query/saved-view consistency while still
   * presenting a friendly templated message in the UI.
   *
   * @internal
   */
  _spanName?: string
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
  { log, tags = [], level = Level.Info, parentSpan, _spanName }: LogOptions = {}
): Span {
  const { formattedMessage, extraAttributes, newTemplate } = logfireFormatWithExtras(msgTemplate, attributes, logfireApiConfig.scrubber)

  const context = parentSpan ? TheTraceAPI.setSpan(TheContextAPI.active(), parentSpan) : TheContextAPI.active()
  const span = logfireApiConfig.tracer.startSpan(
    _spanName ?? msgTemplate,
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
  {
    _spanName?: string
    attributes?: Record<string, unknown>
    callback: SpanCallback<R>
    level?: LogFireLevel
    parentSpan?: Span
    tags?: string[]
  },
]

/**
 * Starts a new Span and calls the given function passing it the
 * created span as first argument.
 * Additionally the new span gets set in context and this context is activated within the execution of the function.
 * The span will be ended automatically after the function call.
 */
export function span<R>(msgTemplate: string, options: SpanArgsVariant2<R>[0]): R
export function span<R>(msgTemplate: string, attributes: Record<string, unknown>, options: LogOptions, callback: (span: Span) => R): R
export function span<R>(msgTemplate: string, ...args: SpanArgsVariant1<R> | SpanArgsVariant2<R>): R {
  let attributes: Record<string, unknown>
  let level: LogFireLevel
  let tags: string[]
  let callback!: SpanCallback<R>
  let parentSpan: Span | undefined
  let spanName: string | undefined
  if (args.length === 1) {
    attributes = args[0].attributes ?? {}
    level = args[0].level ?? Level.Info
    tags = args[0].tags ?? []
    callback = args[0].callback
    parentSpan = args[0].parentSpan
    spanName = args[0]._spanName
  } else {
    attributes = args[0]
    level = args[1].level ?? Level.Info
    tags = args[1].tags ?? []
    parentSpan = args[1].parentSpan
    spanName = args[1]._spanName
    callback = args[2]
  }

  const { formattedMessage, extraAttributes, newTemplate } = logfireFormatWithExtras(msgTemplate, attributes, logfireApiConfig.scrubber)

  const context = parentSpan ? TheTraceAPI.setSpan(TheContextAPI.active(), parentSpan) : TheContextAPI.active()
  return logfireApiConfig.tracer.startActiveSpan(
    spanName ?? msgTemplate,
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
      let result: R
      try {
        result = callback(span)
      } catch (thrown) {
        recordSpanException(span, thrown)
        span.end()
        throw thrown
      }

      if (result instanceof Promise) {
        result.then(
          () => {
            span.end()
          },
          (reason: unknown) => {
            recordSpanException(span, reason)
            span.end()
          }
        )
        // we need this clunky detection because of zone.js promises
      } else if (typeof result === 'object' && result !== null && 'finally' in result && typeof result.finally === 'function') {
        const resultWithFinally = result as { finally: (onFinally: () => void) => unknown }
        resultWithFinally.finally(() => {
          span.end()
        })
      } else {
        span.end()
      }
      return result
    }
  )
}

export function log(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}): void {
  startSpan(message, attributes, { ...options, log: true }).end()
}

export function debug(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}): void {
  log(message, attributes, { ...options, level: Level.Debug })
}

export function info(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}): void {
  log(message, attributes, { ...options, level: Level.Info })
}

export function trace(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}): void {
  log(message, attributes, { ...options, level: Level.Trace })
}

export function error(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}): void {
  log(message, attributes, { ...options, level: Level.Error })
}

export function fatal(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}): void {
  log(message, attributes, { ...options, level: Level.Fatal })
}

export function notice(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}): void {
  log(message, attributes, { ...options, level: Level.Notice })
}

export function warning(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}): void {
  log(message, attributes, { ...options, level: Level.Warning })
}

function recordSpanException(span: Span, thrown: unknown): void {
  const isError = thrown instanceof Error
  const errorMessage = isError ? thrown.message : String(thrown)
  const errorName = isError ? thrown.name : 'Error'

  span.recordException(isError ? thrown : String(thrown))
  span.setStatus({ code: SpanStatusCode.ERROR, message: `${errorName}: ${errorMessage}` })
  span.setAttribute(ATTRIBUTES_LEVEL_KEY, Level.Error)

  if (isError && logfireApiConfig.enableErrorFingerprinting) {
    span.setAttribute(ATTRIBUTES_EXCEPTION_FINGERPRINT_KEY, computeFingerprint(thrown))
  }
}

/**
 * Use this method to report an error to Logfire.
 * Captures the error stack trace and message in the respective semantic attributes and sets the correct level and status.
 * Computes a fingerprint for the error to enable issue grouping in the Logfire backend (if errorFingerprinting is enabled).
 */
export function reportError(message: string, error: Error, extraAttributes: Record<string, unknown> = {}): void {
  const attributes: Record<string, unknown> = {
    [ATTR_EXCEPTION_MESSAGE]: error.message,
    [ATTR_EXCEPTION_STACKTRACE]: error.stack,
    ...extraAttributes,
  }

  if (logfireApiConfig.enableErrorFingerprinting) {
    attributes[ATTRIBUTES_EXCEPTION_FINGERPRINT_KEY] = computeFingerprint(error)
  }

  const span = startSpan(message, attributes, { level: Level.Error })

  span.recordException(error)
  span.setStatus({ code: SpanStatusCode.ERROR, message: `${error.name}: ${error.message}` })
  span.end()
}

const defaultExport: {
  LogfireAttributeScrubber: typeof LogfireAttributeScrubber
  NoopAttributeScrubber: typeof NoopAttributeScrubber
  NoopScrubber: NoopAttributeScrubber
  SpanLevel: typeof SpanLevel
  TailSamplingProcessor: typeof TailSamplingProcessor
  ULIDGenerator: typeof ULIDGenerator
  canonicalizeError: typeof canonicalizeError
  checkTraceIdRatio: typeof checkTraceIdRatio
  configureLogfireApi: typeof configureLogfireApi
  computeFingerprint: typeof computeFingerprint
  debug: typeof debug
  error: typeof error
  fatal: typeof fatal
  info: typeof info
  levelOrDuration: typeof levelOrDuration
  log: typeof log
  logfireApiConfig: typeof logfireApiConfig
  notice: typeof notice
  reportError: typeof reportError
  resolveBaseUrl: typeof resolveBaseUrl
  resolveSendToLogfire: typeof resolveSendToLogfire
  serializeAttributes: typeof serializeAttributes
  span: typeof span
  startSpan: typeof startSpan
  trace: typeof trace
  warning: typeof warning
  Level: typeof Level
} = {
  LogfireAttributeScrubber,
  NoopAttributeScrubber,
  NoopScrubber,
  SpanLevel,
  TailSamplingProcessor,
  ULIDGenerator,
  canonicalizeError,
  checkTraceIdRatio,
  configureLogfireApi,
  computeFingerprint,
  debug,
  error,
  fatal,
  info,
  levelOrDuration,
  log,
  logfireApiConfig,
  notice,
  reportError,
  resolveBaseUrl,
  resolveSendToLogfire,
  serializeAttributes,
  span,
  startSpan,
  trace,
  warning,
  Level,
}

export default defaultExport
