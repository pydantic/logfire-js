import type { Attributes, Context, HrTime, Span } from '@opentelemetry/api'
import { SpanStatusCode, context as TheContextAPI, propagation as ThePropagationAPI, trace as TheTraceAPI } from '@opentelemetry/api'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { ATTR_EXCEPTION_MESSAGE, ATTR_EXCEPTION_STACKTRACE } from '@opentelemetry/semantic-conventions'

import { LogfireAttributeScrubber, NoopAttributeScrubber, NoopScrubber } from './AttributeScrubber'
import {
  ATTRIBUTES_EXCEPTION_FINGERPRINT_KEY,
  ATTRIBUTES_LEVEL_KEY,
  ATTRIBUTES_MESSAGE_KEY,
  ATTRIBUTES_MESSAGE_TEMPLATE_KEY,
  ATTRIBUTES_PENDING_SPAN_REAL_PARENT_KEY,
  ATTRIBUTES_SCRUBBED_KEY,
  ATTRIBUTES_SPAN_TYPE_KEY,
  ATTRIBUTES_TAGS_KEY,
  INVALID_SPAN_ID,
  JSON_NULL_FIELDS_KEY,
  JSON_SCHEMA_KEY,
} from './constants'
import { canonicalizeError, computeFingerprint } from './fingerprint'
import { logfireFormatWithExtras, truncateString } from './formatter'
import { configureLogfireApi, logfireApiConfig, resolveBaseUrl, resolveSendToLogfire, serializeAttributes } from './logfireApiConfig'
import { PendingSpanProcessor } from './PendingSpanProcessor'
import { setPendingSpanSuppressed } from './pendingSpanSuppression'
import { SpanLevel, checkTraceIdRatio, levelOrDuration } from './sampling'
import { TailSamplingProcessor } from './TailSamplingProcessor'
import { ULIDGenerator } from './ULIDGenerator'

export * from './AttributeScrubber'
export { canonicalizeError, computeFingerprint } from './fingerprint'
export { configureLogfireApi, logfireApiConfig, resolveBaseUrl, resolveSendToLogfire } from './logfireApiConfig'
export type { BaggageOptions, LogfireApiConfig, LogfireApiConfigOptions, ScrubbingOptions } from './logfireApiConfig'
export { ATTRIBUTES_PENDING_SPAN_REAL_PARENT_KEY } from './constants'
export { PendingSpanProcessor } from './PendingSpanProcessor'
export * from './sampling'
export { serializeAttributes } from './serializeAttributes'
export { TailSamplingProcessor, type TailSamplingProcessorOptions } from './TailSamplingProcessor'
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

export type StartPendingSpanOptions = Omit<LogOptions, 'log'>

export interface LogfireClientSettings {
  level?: LogFireLevel
  tags?: string[]
}

export interface ReportErrorOptions {
  /**
   * Set a span started with `startSpan` as parentSpan to create a child error span.
   */
  parentSpan?: Span
  /**
   * Tags to add to the error span.
   */
  tags?: string[]
}

export interface InstrumentOptions {
  /**
   * Static attributes to add to each instrumented call span.
   */
  attributes?: Record<string, unknown>
  /**
   * Extract positional arguments into span attributes.
   *
   * Defaults to false. Pass a string array for stable names, or true for
   * best-effort parameter-name extraction from function source.
   */
  extractArgs?: boolean | readonly string[]
  /**
   * The log level for the instrumented call span.
   */
  level?: LogFireLevel
  /**
   * The message template for the instrumented call span.
   */
  message?: string
  /**
   * Set a span started with `startSpan` as parentSpan to create a child span.
   */
  parentSpan?: Span
  /**
   * Record successful return values as span attributes.
   */
  recordReturn?: boolean
  /**
   * Override the OTel span name without changing the message template.
   */
  spanName?: string
  /**
   * Tags to add to the instrumented call span.
   */
  tags?: string[]
}

interface LogfireSpanStart {
  attributes: Attributes
  name: string
}

interface ResolvedLogfireClientSettings {
  level?: LogFireLevel
  tags: string[]
}

type ReadableSpanFields = Pick<ReadableSpan, 'parentSpanContext' | 'startTime'>
type InstrumentableFunction = (...args: never[]) => unknown
type SerializedAttributeValue = ReturnType<typeof serializeAttributes>[string]

const ROOT_CLIENT_SETTINGS: ResolvedLogfireClientSettings = { tags: [] }
const BAGGAGE_ATTRIBUTE_PREFIX = 'baggage.' as const
const MAX_BAGGAGE_VALUE_LENGTH = 1000 as const

function mergeTags(...tagGroups: (readonly string[] | undefined)[]): string[] {
  return Array.from(new Set(tagGroups.flatMap((tags) => tags ?? [])).values())
}

function mergeClientSettings(parent: ResolvedLogfireClientSettings, child: LogfireClientSettings): ResolvedLogfireClientSettings {
  const merged: ResolvedLogfireClientSettings = {
    tags: mergeTags(parent.tags, child.tags),
  }
  const level = child.level ?? parent.level
  if (level !== undefined) {
    merged.level = level
  }
  return merged
}

function mergeLogOptions(settings: ResolvedLogfireClientSettings, options: LogOptions | undefined, forcedLevel?: LogFireLevel): LogOptions {
  const merged: LogOptions = {
    ...options,
    tags: mergeTags(settings.tags, options?.tags),
  }
  const level = forcedLevel ?? options?.level ?? settings.level
  if (level !== undefined) {
    merged.level = level
  }
  return merged
}

function getBaggageSpanAttributes(existingAttributes: Record<string, unknown>): Record<string, string> {
  const allowedKeys = logfireApiConfig.baggage.spanAttributes
  if (allowedKeys.length === 0) {
    return {}
  }

  const baggage = ThePropagationAPI.getActiveBaggage()
  if (baggage === undefined) {
    return {}
  }

  const attributes: Record<string, string> = {}
  for (const key of allowedKeys) {
    const attributeKey = `${BAGGAGE_ATTRIBUTE_PREFIX}${key}`
    if (attributeKey in existingAttributes) {
      continue
    }

    const entry = baggage.getEntry(key)
    if (entry === undefined) {
      continue
    }

    attributes[attributeKey] = truncateString(entry.value, MAX_BAGGAGE_VALUE_LENGTH)
  }
  return attributes
}

function buildSerializedLogfireAttributes(
  msgTemplate: string,
  attributes: Record<string, unknown>,
  { tags = [], level = Level.Info }: Pick<LogOptions, 'level' | 'tags'>
): {
  formattedMessage: string
  newTemplate: string
  serializedAttributes: Attributes
} {
  const { formattedMessage, extraAttributes, newTemplate } = logfireFormatWithExtras(msgTemplate, attributes, logfireApiConfig.scrubber)
  const userAttributes = { ...attributes, ...extraAttributes }

  return {
    formattedMessage,
    newTemplate,
    serializedAttributes: {
      ...serializeAttributes({ ...getBaggageSpanAttributes(userAttributes), ...userAttributes }),
      [ATTRIBUTES_MESSAGE_TEMPLATE_KEY]: newTemplate,
      [ATTRIBUTES_MESSAGE_KEY]: formattedMessage,
      [ATTRIBUTES_LEVEL_KEY]: level,
      [ATTRIBUTES_TAGS_KEY]: Array.from(new Set(tags).values()),
    },
  }
}

function buildLogfireSpanStart(
  msgTemplate: string,
  attributes: Record<string, unknown>,
  { log, tags = [], level = Level.Info, _spanName }: Pick<LogOptions, '_spanName' | 'level' | 'log' | 'tags'>
): LogfireSpanStart {
  const { serializedAttributes } = buildSerializedLogfireAttributes(msgTemplate, attributes, { tags, level })

  return {
    attributes: {
      ...serializedAttributes,
      [ATTRIBUTES_SPAN_TYPE_KEY]: log ? 'log' : 'span',
    },
    name: _spanName ?? msgTemplate,
  }
}

function getSpanStartContext(parentSpan: Span | undefined): Context {
  const activeContext = TheContextAPI.active()
  return parentSpan ? TheTraceAPI.setSpan(activeContext, parentSpan) : activeContext
}

function getReadableSpanFields(span: Span): Partial<ReadableSpanFields> {
  return span as unknown as Partial<ReadableSpanFields>
}

function isHrTime(value: unknown): value is HrTime {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'number' && typeof value[1] === 'number'
}

function getFunctionName(fn: InstrumentableFunction): string {
  return fn.name || 'function'
}

function extractParamNames(fn: InstrumentableFunction): string[] {
  const src = fn.toString()
  // Crude by design: this is opt-in and exists for readable development builds.
  const match = /^(?:async\s+)?(?:function[^(]*)?\(([^)]*)\)/u.exec(src)
  if (match === null) {
    return []
  }
  const inside = match[1]?.trim() ?? ''
  if (inside === '') {
    return []
  }
  return inside.split(',').map((param) => {
    const trimmed = param.trim()
    return trimmed.replace(/[=:].*$/u, '').trim()
  })
}

function buildInstrumentedCallAttributes(
  fn: InstrumentableFunction,
  args: readonly unknown[],
  options: InstrumentOptions
): Record<string, unknown> {
  const attributes: Record<string, unknown> = { ...(options.attributes ?? {}) }
  if (options.extractArgs === undefined || options.extractArgs === false) {
    return attributes
  }

  const argNames: readonly string[] = Array.isArray(options.extractArgs) ? options.extractArgs : extractParamNames(fn)
  for (let i = 0; i < args.length; i++) {
    const argName = argNames[i] ?? `arg${i.toString()}`
    attributes[argName] = args[i]
  }
  return attributes
}

function buildInstrumentedCallSerializationAttributes(msgTemplate: string, attributes: Record<string, unknown>): Record<string, unknown> {
  const { extraAttributes } = logfireFormatWithExtras(msgTemplate, attributes, logfireApiConfig.scrubber)
  const userAttributes = { ...attributes, ...extraAttributes }
  return { ...getBaggageSpanAttributes(userAttributes), ...userAttributes }
}

function safeSetSpanAttribute(span: Span, key: string, value: SerializedAttributeValue): void {
  try {
    span.setAttribute(key, value)
  } catch {
    // Return recording is best-effort and must never change function outcome.
  }
}

function recordReturnAttributes(span: Span, spanSerializationAttributes: Record<string, unknown>, value: unknown): void {
  try {
    const serializedAttributes = serializeAttributes({ ...spanSerializationAttributes, return: value })
    for (const key of ['return', JSON_SCHEMA_KEY, JSON_NULL_FIELDS_KEY, ATTRIBUTES_SCRUBBED_KEY]) {
      const serializedValue = serializedAttributes[key]
      if (serializedValue !== undefined) {
        safeSetSpanAttribute(span, key, serializedValue)
      }
    }
  } catch {
    safeSetSpanAttribute(span, 'return', '[unserializable]')
  }
}

/**
 * Starts a new Span without setting it on context.
 * This method does NOT modify the current Context.
 * You need to manually call `span.end()` to finish the span.
 */
function startSpanWithSettings(
  settings: ResolvedLogfireClientSettings,
  msgTemplate: string,
  attributes: Record<string, unknown> = {},
  options: LogOptions = {}
): Span {
  options = mergeLogOptions(settings, options)
  const spanStart = buildLogfireSpanStart(msgTemplate, attributes, options)

  const span = logfireApiConfig.tracer.startSpan(
    spanStart.name,
    { attributes: spanStart.attributes },
    getSpanStartContext(options.parentSpan)
  )

  return span
}

export function startSpan(msgTemplate: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}): Span {
  return startSpanWithSettings(ROOT_CLIENT_SETTINGS, msgTemplate, attributes, options)
}

/**
 * Starts a real span and immediately emits a manual pending-span placeholder
 * for it. The returned real span must still be ended by the caller.
 */
function startPendingSpanWithSettings(
  settings: ResolvedLogfireClientSettings,
  msgTemplate: string,
  attributes: Record<string, unknown> = {},
  options: StartPendingSpanOptions = {}
): Span {
  options = mergeLogOptions(settings, options)
  const spanStart = buildLogfireSpanStart(msgTemplate, attributes, options)
  const parentContext = getSpanStartContext(options.parentSpan)
  const realSpan = logfireApiConfig.tracer.startSpan(
    spanStart.name,
    { attributes: spanStart.attributes },
    setPendingSpanSuppressed(parentContext)
  )

  if (!realSpan.isRecording()) {
    return realSpan
  }

  const readableSpan = getReadableSpanFields(realSpan)
  const startTime = readableSpan.startTime
  if (!isHrTime(startTime)) {
    return realSpan
  }

  const placeholder = logfireApiConfig.tracer.startSpan(
    spanStart.name,
    {
      attributes: {
        ...spanStart.attributes,
        [ATTRIBUTES_PENDING_SPAN_REAL_PARENT_KEY]: readableSpan.parentSpanContext?.spanId ?? INVALID_SPAN_ID,
        [ATTRIBUTES_SPAN_TYPE_KEY]: 'pending_span',
      },
      startTime,
    },
    TheTraceAPI.setSpan(parentContext, realSpan)
  )
  placeholder.end(startTime)

  return realSpan
}

export function startPendingSpan(
  msgTemplate: string,
  attributes: Record<string, unknown> = {},
  options: StartPendingSpanOptions = {}
): Span {
  return startPendingSpanWithSettings(ROOT_CLIENT_SETTINGS, msgTemplate, attributes, options)
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
  return spanWithSettings(ROOT_CLIENT_SETTINGS, msgTemplate, ...args)
}

function spanWithSettings<R>(
  settings: ResolvedLogfireClientSettings,
  msgTemplate: string,
  ...args: SpanArgsVariant1<R> | SpanArgsVariant2<R>
): R {
  let attributes: Record<string, unknown>
  let level: LogFireLevel
  let tags: string[]
  let callback!: SpanCallback<R>
  let parentSpan: Span | undefined
  let spanName: string | undefined
  if (args.length === 1) {
    const options = args[0]
    attributes = args[0].attributes ?? {}
    level = options.level ?? settings.level ?? Level.Info
    tags = mergeTags(settings.tags, options.tags)
    callback = options.callback
    parentSpan = options.parentSpan
    spanName = options._spanName
  } else {
    const options = mergeLogOptions(settings, args[1])
    attributes = args[0]
    level = options.level ?? Level.Info
    tags = options.tags ?? []
    parentSpan = options.parentSpan
    spanName = options._spanName
    callback = args[2]
  }

  const { serializedAttributes } = buildSerializedLogfireAttributes(msgTemplate, attributes, { tags, level })

  const context = parentSpan ? TheTraceAPI.setSpan(TheContextAPI.active(), parentSpan) : TheContextAPI.active()
  return logfireApiConfig.tracer.startActiveSpan(
    spanName ?? msgTemplate,
    {
      attributes: serializedAttributes,
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

function logWithSettings(
  settings: ResolvedLogfireClientSettings,
  message: string,
  attributes: Record<string, unknown> = {},
  options: LogOptions = {}
): void {
  startSpanWithSettings(settings, message, attributes, { ...options, log: true }).end()
}

export function log(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}): void {
  logWithSettings(ROOT_CLIENT_SETTINGS, message, attributes, options)
}

export function debug(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}): void {
  logWithSettings(ROOT_CLIENT_SETTINGS, message, attributes, { ...options, level: Level.Debug })
}

export function info(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}): void {
  logWithSettings(ROOT_CLIENT_SETTINGS, message, attributes, { ...options, level: Level.Info })
}

export function trace(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}): void {
  logWithSettings(ROOT_CLIENT_SETTINGS, message, attributes, { ...options, level: Level.Trace })
}

export function error(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}): void {
  logWithSettings(ROOT_CLIENT_SETTINGS, message, attributes, { ...options, level: Level.Error })
}

export function fatal(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}): void {
  logWithSettings(ROOT_CLIENT_SETTINGS, message, attributes, { ...options, level: Level.Fatal })
}

export function notice(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}): void {
  logWithSettings(ROOT_CLIENT_SETTINGS, message, attributes, { ...options, level: Level.Notice })
}

export function warning(message: string, attributes: Record<string, unknown> = {}, options: LogOptions = {}): void {
  logWithSettings(ROOT_CLIENT_SETTINGS, message, attributes, { ...options, level: Level.Warning })
}

function instrumentWithSettings<F extends InstrumentableFunction>(
  settings: ResolvedLogfireClientSettings,
  fn: F,
  options: InstrumentOptions = {}
): F {
  const wrapped = function (this: ThisParameterType<F>, ...args: Parameters<F>): ReturnType<F> {
    const message = options.message ?? `Calling ${getFunctionName(fn)}`
    const attributes = buildInstrumentedCallAttributes(fn, args, options)
    const spanSerializationAttributes =
      options.recordReturn === true ? buildInstrumentedCallSerializationAttributes(message, attributes) : undefined
    const spanOptions: SpanArgsVariant2<ReturnType<F>>[0] = {
      attributes,
      callback: (activeSpan) => {
        const result = fn.apply(this, args) as ReturnType<F>
        if (options.recordReturn !== true) {
          return result
        }
        if (result instanceof Promise) {
          return result.then((value: Awaited<ReturnType<F>>) => {
            recordReturnAttributes(activeSpan, spanSerializationAttributes ?? {}, value)
            return value
          }) as ReturnType<F>
        }
        recordReturnAttributes(activeSpan, spanSerializationAttributes ?? {}, result)
        return result
      },
    }
    if (options.level !== undefined) {
      spanOptions.level = options.level
    }
    if (options.parentSpan !== undefined) {
      spanOptions.parentSpan = options.parentSpan
    }
    if (options.spanName !== undefined) {
      spanOptions._spanName = options.spanName
    }
    if (options.tags !== undefined) {
      spanOptions.tags = options.tags
    }
    return spanWithSettings(settings, message, spanOptions)
  }

  return wrapped as F
}

export function instrument<F extends InstrumentableFunction>(fn: F, options: InstrumentOptions = {}): F {
  return instrumentWithSettings(ROOT_CLIENT_SETTINGS, fn, options)
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

interface NormalizedReportError {
  attributes: Record<string, unknown>
  fingerprintSource?: Error
  recordExceptionValue: Error | string
  statusMessage: string
}

function stringifyThrownValue(thrown: unknown): string {
  try {
    return String(thrown)
  } catch {
    return 'Unknown error'
  }
}

function normalizeReportError(error: unknown): NormalizedReportError {
  if (error instanceof Error) {
    return {
      attributes: {
        [ATTR_EXCEPTION_MESSAGE]: error.message,
        [ATTR_EXCEPTION_STACKTRACE]: error.stack,
      },
      fingerprintSource: error,
      recordExceptionValue: error,
      statusMessage: `${error.name}: ${error.message}`,
    }
  }

  const errorMessage = stringifyThrownValue(error)
  return {
    attributes: {
      [ATTR_EXCEPTION_MESSAGE]: errorMessage,
    },
    recordExceptionValue: errorMessage,
    statusMessage: `Error: ${errorMessage}`,
  }
}

function reportErrorOptionsToLogOptions(options: ReportErrorOptions | undefined): LogOptions {
  const logOptions: LogOptions = { level: Level.Error }
  if (options?.parentSpan !== undefined) {
    logOptions.parentSpan = options.parentSpan
  }
  if (options?.tags !== undefined) {
    logOptions.tags = options.tags
  }
  return logOptions
}

/**
 * Use this method to report an error to Logfire.
 * Captures the error stack trace and message in the respective semantic attributes and sets the correct level and status.
 * Computes a fingerprint for the error to enable issue grouping in the Logfire backend (if errorFingerprinting is enabled).
 */
function reportErrorWithSettings(
  settings: ResolvedLogfireClientSettings,
  message: string,
  error: unknown,
  extraAttributes: Record<string, unknown> = {},
  options?: ReportErrorOptions
): void {
  const normalized = normalizeReportError(error)
  const attributes: Record<string, unknown> = {
    ...normalized.attributes,
    ...extraAttributes,
  }

  if (logfireApiConfig.enableErrorFingerprinting && normalized.fingerprintSource !== undefined) {
    attributes[ATTRIBUTES_EXCEPTION_FINGERPRINT_KEY] = computeFingerprint(normalized.fingerprintSource)
  }

  const span = startSpanWithSettings(settings, message, attributes, reportErrorOptionsToLogOptions(options))

  span.recordException(normalized.recordExceptionValue)
  span.setStatus({ code: SpanStatusCode.ERROR, message: normalized.statusMessage })
  span.end()
}

export function reportError(
  message: string,
  error: unknown,
  extraAttributes: Record<string, unknown> = {},
  options?: ReportErrorOptions
): void {
  reportErrorWithSettings(ROOT_CLIENT_SETTINGS, message, error, extraAttributes, options)
}

export interface LogfireClient {
  debug(message: string, attributes?: Record<string, unknown>, options?: LogOptions): void
  error(message: string, attributes?: Record<string, unknown>, options?: LogOptions): void
  fatal(message: string, attributes?: Record<string, unknown>, options?: LogOptions): void
  info(message: string, attributes?: Record<string, unknown>, options?: LogOptions): void
  instrument<F extends InstrumentableFunction>(fn: F, options?: InstrumentOptions): F
  log(message: string, attributes?: Record<string, unknown>, options?: LogOptions): void
  notice(message: string, attributes?: Record<string, unknown>, options?: LogOptions): void
  reportError(message: string, error: unknown, extraAttributes?: Record<string, unknown>, options?: ReportErrorOptions): void
  span: typeof span
  startPendingSpan(message: string, attributes?: Record<string, unknown>, options?: StartPendingSpanOptions): Span
  startSpan(message: string, attributes?: Record<string, unknown>, options?: LogOptions): Span
  trace(message: string, attributes?: Record<string, unknown>, options?: LogOptions): void
  warning(message: string, attributes?: Record<string, unknown>, options?: LogOptions): void
  withSettings(settings: LogfireClientSettings): LogfireClient
  withTags(...tags: string[]): LogfireClient
}

function createLogfireClient(settings: ResolvedLogfireClientSettings): LogfireClient {
  const scopedSpan = (<R>(msgTemplate: string, ...args: SpanArgsVariant1<R> | SpanArgsVariant2<R>) =>
    spanWithSettings(settings, msgTemplate, ...args)) as typeof span

  return {
    debug: (message, attributes, options) => {
      logWithSettings(settings, message, attributes, { ...options, level: Level.Debug })
    },
    error: (message, attributes, options) => {
      logWithSettings(settings, message, attributes, { ...options, level: Level.Error })
    },
    fatal: (message, attributes, options) => {
      logWithSettings(settings, message, attributes, { ...options, level: Level.Fatal })
    },
    info: (message, attributes, options) => {
      logWithSettings(settings, message, attributes, { ...options, level: Level.Info })
    },
    instrument: (fn, options) => instrumentWithSettings(settings, fn, options),
    log: (message, attributes, options) => {
      logWithSettings(settings, message, attributes, options)
    },
    notice: (message, attributes, options) => {
      logWithSettings(settings, message, attributes, { ...options, level: Level.Notice })
    },
    reportError: (message, error, extraAttributes, options) => {
      reportErrorWithSettings(settings, message, error, extraAttributes, options)
    },
    span: scopedSpan,
    startPendingSpan: (message, attributes, options) => startPendingSpanWithSettings(settings, message, attributes, options),
    startSpan: (message, attributes, options) => startSpanWithSettings(settings, message, attributes, options),
    trace: (message, attributes, options) => {
      logWithSettings(settings, message, attributes, { ...options, level: Level.Trace })
    },
    warning: (message, attributes, options) => {
      logWithSettings(settings, message, attributes, { ...options, level: Level.Warning })
    },
    withSettings: (childSettings) => createLogfireClient(mergeClientSettings(settings, childSettings)),
    withTags: (...tags) => createLogfireClient(mergeClientSettings(settings, { tags })),
  }
}

const defaultClient = createLogfireClient(ROOT_CLIENT_SETTINGS)

export function withSettings(settings: LogfireClientSettings): LogfireClient {
  return defaultClient.withSettings(settings)
}

export function withTags(...tags: string[]): LogfireClient {
  return defaultClient.withTags(...tags)
}

const defaultExport: {
  LogfireAttributeScrubber: typeof LogfireAttributeScrubber
  NoopAttributeScrubber: typeof NoopAttributeScrubber
  NoopScrubber: NoopAttributeScrubber
  PendingSpanProcessor: typeof PendingSpanProcessor
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
  instrument: typeof instrument
  levelOrDuration: typeof levelOrDuration
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
  Level: typeof Level
} = {
  LogfireAttributeScrubber,
  NoopAttributeScrubber,
  NoopScrubber,
  PendingSpanProcessor,
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
  instrument,
  levelOrDuration,
  log,
  get logfireApiConfig() {
    return logfireApiConfig
  },
  notice,
  reportError,
  resolveBaseUrl,
  resolveSendToLogfire,
  serializeAttributes,
  span,
  startPendingSpan,
  startSpan,
  trace,
  warning,
  withSettings,
  withTags,
  Level,
}

export default defaultExport
