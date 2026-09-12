/// <reference types="@cloudflare/workers-types" />

import type { Span, Tracer } from '@opentelemetry/api'
import { SpanStatusCode, trace } from '@opentelemetry/api'
import { describe, expect, it, vitest } from 'vitest'
import { instrumentKV, KVAttributes } from '../../src/instrumentation/kv'

function createSpan() {
  return {
    end: vitest.fn<() => void>(),
    recordException: vitest.fn<(exception: unknown) => void>(),
    setAttribute: vitest.fn<(key: string, value: unknown) => void>(),
    setAttributes: vitest.fn<(attributes: Record<string, unknown>) => void>(),
    setStatus: vitest.fn<(status: { code: SpanStatusCode }) => void>(),
  }
}

function mockTracer(span: Span) {
  return {
    async startActiveSpan(_name: string, _options: unknown, fn: (span: Span) => Promise<unknown>) {
      return fn(span)
    },
  } as unknown as Tracer
}

describe('KV attributes', () => {
  it('records the response cursor for incomplete list results', () => {
    expect(KVAttributes.list([{ cursor: 'request-cursor', limit: 10 }], { list_complete: false, cursor: 'response-cursor' })).toMatchObject(
      {
        'db.cf.kv.list_request_cursor': 'request-cursor',
        'db.cf.kv.list_limit': 10,
        'db.cf.kv.list_response_cursor': 'response-cursor',
      }
    )
  })

  it('omits the prefix from the list query text when there is none', async () => {
    const attributes: Record<string, unknown> = {}
    const span = createSpan()
    span.setAttribute = ((key: string, value: unknown) => {
      attributes[key] = value
    }) as unknown as typeof span.setAttribute
    const getTracer = vitest.spyOn(trace, 'getTracer').mockReturnValue(mockTracer(span as unknown as Span))
    const kv = {
      list: vitest.fn<() => Promise<unknown>>(async () => Promise.resolve({ keys: [], list_complete: true })),
    } as unknown as KVNamespace

    try {
      await instrumentKV(kv, 'CACHE').list()
      expect(attributes['db.query.text']).toBe('list')

      await instrumentKV(kv, 'CACHE').list({ prefix: 'user:' })
      expect(attributes['db.query.text']).toBe('list user:')
    } finally {
      getTracer.mockRestore()
    }
  })

  it('records errors and ends spans when KV operations reject', async () => {
    const error = new Error('kv failed')
    const span = createSpan()
    const getTracer = vitest.spyOn(trace, 'getTracer').mockReturnValue(mockTracer(span as unknown as Span))
    const kv = {
      get: vitest.fn<() => Promise<unknown>>(async () => Promise.reject(error)),
    } as unknown as KVNamespace

    try {
      await expect(instrumentKV(kv, 'CACHE').get('key')).rejects.toBe(error)
      expect(span.recordException).toHaveBeenCalledWith(error)
      expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR })
      expect(span.end).toHaveBeenCalledTimes(1)
    } finally {
      getTracer.mockRestore()
    }
  })
})
