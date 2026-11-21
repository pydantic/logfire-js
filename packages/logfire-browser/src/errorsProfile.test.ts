import { SpanStatusCode } from '@opentelemetry/api'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-web'
import { Level, SpanLevel } from 'logfire'
import type { TailSamplingSpanInfo } from 'logfire'
import { describe, expect, it } from 'vite-plus/test'

import { keepFailedTraces } from './errorsProfile'

describe('keepFailedTraces', () => {
  it.each([
    ['an error-level span', Level.Error, SpanStatusCode.UNSET, {}, 1],
    ['a fatal-level span', Level.Fatal, SpanStatusCode.UNSET, {}, 1],
    ['a span with an error status', Level.Info, SpanStatusCode.ERROR, {}, 1],
    ['a 5xx response under the default HTTP conventions', Level.Info, SpanStatusCode.UNSET, { 'http.status_code': 503 }, 1],
    ['a 5xx response under the stable HTTP conventions', Level.Info, SpanStatusCode.UNSET, { 'http.response.status_code': 500 }, 1],
    ['a 4xx response', Level.Info, SpanStatusCode.UNSET, { 'http.status_code': 404 }, 0],
    ['a warning', Level.Warning, SpanStatusCode.UNSET, {}, 0],
    ['a healthy span', Level.Info, SpanStatusCode.OK, { 'http.status_code': 200 }, 0],
  ] as const)('keeps %s with rate %d', (_name, level, statusCode, attributes, rate) => {
    expect(keepFailedTraces(spanInfo(level, statusCode, attributes))).toBe(rate)
  })
})

function spanInfo(level: number, statusCode: SpanStatusCode, attributes: Record<string, number>): TailSamplingSpanInfo {
  const span = { attributes: { 'logfire.level_num': level, ...attributes }, status: { code: statusCode } } as unknown as ReadableSpan
  return { context: null, duration: 0, event: 'end', level: SpanLevel.fromSpan(span), span }
}
