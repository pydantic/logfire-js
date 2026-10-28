import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { configureLogfireApi } from 'logfire'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { LogfireCloudflareConsoleSpanExporter } from './LogfireCloudflareConsoleSpanExporter'
import type { IExportTraceServiceRequest } from './OtlpTransformerTypes'
import { TailWorkerExporter } from './TailWorkerExporter'

describe('cf-workers export-time scrubbing', () => {
  beforeEach(() => {
    configureLogfireApi({ scrubbing: {} })
  })

  afterEach(() => {
    vi.doUnmock('@pydantic/otel-cf-workers')
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it('scrubs late attributes and events on logfire spans in the in-process post processor', async () => {
    vi.resetModules()
    type PostProcessor = (spans: ReadableSpan[]) => ReadableSpan[]
    let capturedConfigFn: ((env: Record<string, string>) => { postProcessor: PostProcessor }) | undefined
    vi.doMock('@pydantic/otel-cf-workers', () => ({
      instrument: (handler: unknown, configFn: typeof capturedConfigFn): unknown => {
        capturedConfigFn = configFn
        return handler
      },
      instrumentDO: (doClass: unknown): unknown => doClass,
      OTLP_EXPORTER_USER_AGENT: 'otel-cf-workers/0.0.0',
    }))
    const { instrumentInProcess } = await import('./index')
    instrumentInProcess({}, { service: { name: 'test-service' } })
    const postProcessor = capturedConfigFn?.({ LOGFIRE_TOKEN: 'test-token' }).postProcessor
    const span = {
      attributes: { 'logfire.span_type': 'span', 'logfire.msg': 'checkout', 'late.password': 'hunter2' },
      events: [{ attributes: { note: 'session=abc' }, name: 'event', time: [0, 0] }],
      links: [],
      status: { code: 0 },
    } as unknown as ReadableSpan

    postProcessor?.([span])

    expect(span.attributes).toEqual({
      'logfire.span_type': 'span',
      'logfire.msg': 'checkout',
      'late.password': "[Scrubbed due to 'password']",
      'logfire.scrubbed': JSON.stringify([
        { matched_substring: 'password', path: ['attributes', 'late.password'] },
        { matched_substring: 'session', path: ['otel_events', 0, 'attributes', 'note'] },
      ]),
    })
    expect(span.events[0]?.attributes).toEqual({ note: "[Scrubbed due to 'session']" })
  })

  it('scrubs spans before the tail worker exporter writes them out', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new TailWorkerExporter())] })
    const span = provider.getTracer('instrumentation').startSpan('fetch', { attributes: { 'http.request.header.cookie': 'abc' } })
    span.end()

    const message = log.mock.calls[0]?.[0] as IExportTraceServiceRequest
    expect(message.resourceSpans?.[0]?.scopeSpans[0]?.spans?.[0]?.attributes).toEqual([
      { key: 'http.request.header.cookie', value: { stringValue: "[Scrubbed due to 'cookie']" } },
      {
        key: 'logfire.scrubbed',
        value: { stringValue: JSON.stringify([{ matched_substring: 'cookie', path: ['attributes', 'http.request.header.cookie'] }]) },
      },
    ])
  })

  it('prints a scrubbed copy to the console and leaves the span for the export pass', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new LogfireCloudflareConsoleSpanExporter())] })
    const span = provider.getTracer('instrumentation').startSpan('fetch', { attributes: { 'http.request.header.cookie': 'abc' } })
    span.end()

    expect(log.mock.calls[2]?.[0]).toBe(
      JSON.stringify(
        {
          'http.request.header.cookie': "[Scrubbed due to 'cookie']",
          'logfire.scrubbed': JSON.stringify([{ matched_substring: 'cookie', path: ['attributes', 'http.request.header.cookie'] }]),
        },
        null,
        2
      )
    )
    expect((span as unknown as ReadableSpan).attributes).toEqual({ 'http.request.header.cookie': 'abc' })
  })
})
