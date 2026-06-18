import type { Attributes, Context, Exception, HrTime, Span } from '@opentelemetry/api'
import {
  INVALID_SPAN_CONTEXT,
  SpanStatusCode,
  context as TheContextAPI,
  propagation as ThePropagationAPI,
  trace as TheTraceAPI,
} from '@opentelemetry/api'
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
import { Level } from './levels'
import type { LogFireLevel } from './levels'
import { configureLogfireApi, logfireApiConfig, resolveBaseUrl, resolveSendToLogfire, serializeAttributes } from './logfireApiConfig'
import { PendingSpanProcessor } from './PendingSpanProcessor'
import { setPendingSpanSuppressed } from './pendingSpanSuppression'
import { SpanLevel, checkTraceIdRatio, levelOrDuration } from './sampling'
import { TailSamplingProcessor } from './TailSamplingProcessor'
import { ULIDGenerator } from './ULIDGenerator'

export * from './AttributeScrubber'
export { canonicalizeError, computeFingerprint } from './fingerprint'
export { configureLogfireApi, logfireApiConfig, resolveBaseUrl, resolveSendToLogfire } from './logfireApiConfig'
export type {
  BaggageOptions,
  JsonSchemaMode,
  LevelName,
  LogFireLevel,
  LogfireApiConfig,
  LogfireApiConfigOptions,
  MinLevel,
  ScrubbingOptions,
} from './logfireApiConfig'
export { ATTRIBUTES_PENDING_SPAN_REAL_PARENT_KEY } from './constants'
export { Level } from './levels'
export { PendingSpanProcessor } from './PendingSpanProcessor'
export * from './sampling'
export { serializeAttributes } from './serializeAttributes'
export { TailSamplingProcessor, type TailSamplingProcessorOptions } from './TailSamplingProcessor'
export * from './ULIDGenerator'

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

type LevelSource = 'default' | 'explicit'

interface ResolvedLogOptions extends Omit<LogOptions, 'level' | 'tags'> {
  level: LogFireLevel
  levelSource: LevelSource
  tags: string[]
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
const NOOP_SPAN = TheTraceAPI.wrapSpanContext(INVALID_SPAN_CONTEXT)

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

function resolveLogOptions(settings: ResolvedLogfireClientSettings, options: LogOptions | undefined): ResolvedLogOptions {
  const merged: ResolvedLogOptions = {
    ...options,
    level: Level.Info,
    levelSource: 'default',
    tags: mergeTags(settings.tags, options?.tags),
  }
  if (options?.level !== undefined) {
    merged.level = options.level
    merged.levelSource = 'explicit'
  } else if (settings.level !== undefined) {
    merged.level = settings.level
    merged.levelSource = 'explicit'
  }
  return merged
}

function resolveLogLevel(
  settings: ResolvedLogfireClientSettings,
  options: { level?: LogFireLevel } | undefined
): {
  level: LogFireLevel
  source: LevelSource
} {
  if (options?.level !== undefined) {
    return { level: options.level, source: 'explicit' }
  }
  if (settings.level !== undefined) {
    return { level: settings.level, source: 'explicit' }
  }
  return { level: Level.Info, source: 'default' }
}

function shouldFilterLevel(level: LogFireLevel, source: LevelSource, alwaysFilter: boolean): boolean {
  const minLevel = logfireApiConfig.minLevel
  if (minLevel === undefined) {
    return false
  }
  if (!alwaysFilter && source !== 'explicit') {
    return false
  }
  return level < minLevel
}

function getNoopSpan(): Span {
  return NOOP_SPAN
}

function withNoopSpan<R>(callback: SpanCallback<R>): R {
  return callback(getNoopSpan())
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
  serializationAttributes: Record<string, unknown>
  serializedAttributes: Attributes
} {
  const { formattedMessage, extraAttributes, newTemplate } = logfireFormatWithExtras(msgTemplate, attributes, logfireApiConfig.scrubber)
  const userAttributes = { ...attributes, ...extraAttributes }
  const serializationAttributes = { ...getBaggageSpanAttributes(userAttributes), ...userAttributes }

  return {
    formattedMessage,
    newTemplate,
    serializationAttributes,
    serializedAttributes: {
      ...serializeAttributes(serializationAttributes),
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

function isThenable<T>(value: T): value is T & PromiseLike<Awaited<T>> {
  return (
    (typeof value === 'object' || typeof value === 'function') && value !== null && typeof (value as { then?: unknown }).then === 'function'
  )
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
    // Late-added metadata is best-effort and must never change function outcome.
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

function recordSerializedAttributes(span: Span, attributes: Record<string, unknown>, keys: readonly string[]): void {
  try {
    const serializedAttributes = serializeAttributes(attributes)
    for (const key of keys) {
      const serializedValue = serializedAttributes[key]
      if (serializedValue !== undefined) {
        safeSetSpanAttribute(span, key, serializedValue)
      }
    }
  } catch {
    // Exception metadata is best-effort and must never change error propagation.
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
  const resolvedOptions = resolveLogOptions(settings, options)
  if (shouldFilterLevel(resolvedOptions.level, resolvedOptions.levelSource, resolvedOptions.log === true)) {
    return getNoopSpan()
  }
  const spanStart = buildLogfireSpanStart(msgTemplate, attributes, resolvedOptions)

  const span = logfireApiConfig.tracer.startSpan(
    spanStart.name,
    { attributes: spanStart.attributes },
    getSpanStartContext(resolvedOptions.parentSpan)
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
  const resolvedOptions = resolveLogOptions(settings, options)
  if (shouldFilterLevel(resolvedOptions.level, resolvedOptions.levelSource, false)) {
    return getNoopSpan()
  }
  const spanStart = buildLogfireSpanStart(msgTemplate, attributes, resolvedOptions)
  const parentContext = getSpanStartContext(resolvedOptions.parentSpan)
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
  let levelSource: LevelSource
  let tags: string[]
  let callback!: SpanCallback<R>
  let parentSpan: Span | undefined
  let spanName: string | undefined
  if (args.length === 1) {
    const options = args[0]
    const resolvedLevel = resolveLogLevel(settings, options)
    attributes = args[0].attributes ?? {}
    level = resolvedLevel.level
    levelSource = resolvedLevel.source
    tags = mergeTags(settings.tags, options.tags)
    callback = options.callback
    parentSpan = options.parentSpan
    spanName = options._spanName
  } else {
    const options = resolveLogOptions(settings, args[1])
    attributes = args[0]
    level = options.level
    levelSource = options.levelSource
    tags = options.tags
    parentSpan = options.parentSpan
    spanName = options._spanName
    callback = args[2]
  }

  if (shouldFilterLevel(level, levelSource, false)) {
    return withNoopSpan(callback)
  }

  const { serializationAttributes, serializedAttributes } = buildSerializedLogfireAttributes(msgTemplate, attributes, { tags, level })

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
        recordSpanException(span, thrown, serializationAttributes)
        span.end()
        throw thrown
      }

      if (result instanceof Promise) {
        result.then(
          () => {
            span.end()
          },
          (reason: unknown) => {
            recordSpanException(span, reason, serializationAttributes)
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
    const resolvedLevel = resolveLogLevel(settings, options)
    if (shouldFilterLevel(resolvedLevel.level, resolvedLevel.source, false)) {
      return fn.apply(this, args) as ReturnType<F>
    }
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
        if (isThenable(result)) {
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

function recordSpanException(span: Span, thrown: unknown, spanSerializationAttributes: Record<string, unknown> = {}): void {
  const isError = thrown instanceof Error
  const errorMessage = isError ? thrown.message : String(thrown)
  const errorName = isError ? thrown.name : 'Error'

  span.recordException(isError ? normalizeRecordException(thrown) : String(thrown))
  span.setStatus({ code: SpanStatusCode.ERROR, message: `${errorName}: ${errorMessage}` })
  span.setAttribute(ATTRIBUTES_LEVEL_KEY, Level.Error)

  if (isError && logfireApiConfig.enableErrorFingerprinting) {
    span.setAttribute(ATTRIBUTES_EXCEPTION_FINGERPRINT_KEY, computeFingerprint(thrown))
  }

  if (isError && thrown.cause !== undefined) {
    recordSerializedAttributes(span, { ...spanSerializationAttributes, [ATTR_EXCEPTION_CAUSE]: normalizeErrorCause(thrown) }, [
      ATTR_EXCEPTION_CAUSE,
      JSON_SCHEMA_KEY,
      JSON_NULL_FIELDS_KEY,
      ATTRIBUTES_SCRUBBED_KEY,
    ])
  }
}

interface NormalizedReportError {
  attributes: Record<string, unknown>
  fingerprintSource?: Error
  recordExceptionValue: Exception
  statusMessage: string
}

const ATTR_EXCEPTION_CAUSE = 'exception.cause' as const

function stringifyThrownValue(thrown: unknown): string {
  try {
    return String(thrown)
  } catch {
    return 'Unknown error'
  }
}

function formatErrorStackWithCauses(error: Error, seen: WeakSet<Error> = new WeakSet<Error>()): string {
  if (seen.has(error)) {
    return `[Circular cause: ${error.name}: ${error.message}]`
  }
  seen.add(error)

  const stack = error.stack ?? `${error.name}: ${error.message}`
  if (error.cause === undefined) {
    return stack
  }

  const cause = error.cause instanceof Error ? formatErrorStackWithCauses(error.cause, seen) : stringifyThrownValue(error.cause)
  return `${stack}\nCaused by: ${cause}`
}

function getErrorCode(error: Error): string | number | undefined {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' || typeof code === 'number' ? code : undefined
}

function normalizeRecordException(error: Error): Exception {
  if (error.cause === undefined) {
    return error
  }

  const code = getErrorCode(error)
  return {
    ...(code !== undefined ? { code } : {}),
    message: error.message,
    name: error.name,
    stack: formatErrorStackWithCauses(error),
  }
}

function normalizeErrorCause(error: Error): unknown {
  const seen = new WeakSet<Error>()
  seen.add(error)
  return normalizeExceptionCause(error.cause, seen)
}

function normalizeExceptionCause(cause: unknown, seen: WeakSet<Error> = new WeakSet<Error>()): unknown {
  if (!(cause instanceof Error)) {
    return { value: cause }
  }

  if (seen.has(cause)) {
    return {
      circular: true,
      message: cause.message,
      type: cause.name,
    }
  }
  seen.add(cause)

  const code = getErrorCode(cause)
  const normalized: Record<string, unknown> = {
    message: cause.message,
    stacktrace: cause.stack,
    type: cause.name,
    ...(code !== undefined ? { code } : {}),
  }

  for (const [key, value] of Object.entries(cause)) {
    if (['cause', 'code', 'message', 'name', 'stack'].includes(key)) {
      continue
    }
    normalized[key] = value
  }

  if (cause.cause !== undefined) {
    normalized['cause'] = normalizeExceptionCause(cause.cause, seen)
  }

  seen.delete(cause)
  return normalized
}

function normalizeReportError(error: unknown): NormalizedReportError {
  if (error instanceof Error) {
    return {
      attributes: {
        ...(error.cause !== undefined ? { [ATTR_EXCEPTION_CAUSE]: normalizeErrorCause(error) } : {}),
        [ATTR_EXCEPTION_MESSAGE]: error.message,
        [ATTR_EXCEPTION_STACKTRACE]: error.cause === undefined ? error.stack : formatErrorStackWithCauses(error),
      },
      fingerprintSource: error,
      recordExceptionValue: normalizeRecordException(error),
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
