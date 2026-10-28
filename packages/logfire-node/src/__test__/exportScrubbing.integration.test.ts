import { trace } from '@opentelemetry/api'
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import * as logfire from 'logfire'
import { configureLogfireApi, PendingSpanProcessor } from 'logfire'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import { ScrubbingLogRecordProcessor } from '../logsExporter'
import { LogfireSpanProcessor } from '../traceExporter'

describe('export-time scrubbing', () => {
  beforeEach(() => {
    configureLogfireApi({ scrubbing: {} })
  })

  afterEach(() => {
    trace.disable()
  })

  it('runs the scrubbing callback once for attributes the logfire API scrubbed at creation', async () => {
    const paths: unknown[] = []
    configureLogfireApi({
      scrubbing: {
        callback: (match) => {
          paths.push(match.path)
          return match.path.at(-1) === 'allowed_password' ? match.value : null
        },
      },
    })
    const exporter = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({ spanProcessors: [new LogfireSpanProcessor(new SimpleSpanProcessor(exporter), undefined)] })
    trace.setGlobalTracerProvider(provider)
    // The API's proxy tracer keeps the first provider it resolved; reconfiguring fetches a fresh one.
    configureLogfireApi({ otelScope: 'logfire' })

    logfire.span('checkout', { allowed_password: 'kept' }, {}, (span) => {
      span.setAttribute('late_password', 'hunter2')
    })
    await provider.forceFlush()

    const [exported] = exporter.getFinishedSpans()
    expect(paths).toEqual([['allowed_password'], ['attributes', 'late_password']])
    expect(exported?.attributes['allowed_password']).toBe('kept')
    expect(exported?.attributes['late_password']).toBe("[Scrubbed due to 'password']")
  })

  it('scrubs pending span copies once and keeps events added later out of them', async () => {
    const paths: unknown[] = []
    configureLogfireApi({
      scrubbing: {
        callback: (match) => {
          paths.push(match.path)
          return null
        },
      },
    })
    const exporter = new InMemorySpanExporter()
    const primary = new LogfireSpanProcessor(new SimpleSpanProcessor(exporter), undefined)
    const provider = new BasicTracerProvider({ spanProcessors: [primary, new PendingSpanProcessor(primary)] })
    trace.setGlobalTracerProvider(provider)
    // The API's proxy tracer keeps the first provider it resolved; reconfiguring fetches a fresh one.
    configureLogfireApi({ otelScope: 'logfire' })

    const span = logfire.startSpan('checkout', { password: 'hunter2' })
    span.addEvent('retry', { note: 'session=abc' })
    span.end()
    await provider.forceFlush()

    const [pending, real] = exporter.getFinishedSpans()
    const creationNotes = JSON.stringify([{ matched_substring: 'password', path: ['password'] }])
    expect(paths).toEqual([['password'], ['otel_events', 0, 'attributes', 'note']])
    expect(pending?.attributes['logfire.span_type']).toBe('pending_span')
    expect(pending?.attributes['logfire.scrubbed']).toBe(creationNotes)
    expect(pending?.events).toEqual([])
    expect(real?.attributes['password']).toBe("[Scrubbed due to 'password']")
    expect(real?.events[0]?.attributes).toEqual({ note: "[Scrubbed due to 'session']" })
  })

  it('leaves the real span link attributes raw when its pending copy is scrubbed', async () => {
    const values: unknown[] = []
    configureLogfireApi({
      scrubbing: {
        callback: (match) => {
          values.push(match.value)
          return null
        },
      },
    })
    const exporter = new InMemorySpanExporter()
    const primary = new LogfireSpanProcessor(new SimpleSpanProcessor(exporter), undefined)
    const provider = new BasicTracerProvider({ spanProcessors: [primary, new PendingSpanProcessor(primary)] })
    const context = { spanId: '0000000000000001', traceFlags: 1, traceId: '00000000000000000000000000000001' }
    provider
      .getTracer('instrumentation')
      .startSpan('job', { links: [{ attributes: { 'auth.header': 'Bearer abc' }, context }] })
      .end()
    await provider.forceFlush()

    const [pending, real] = exporter.getFinishedSpans()
    expect(values).toEqual(['Bearer abc', 'Bearer abc'])
    expect(pending?.links[0]?.attributes).toEqual({ 'auth.header': "[Scrubbed due to 'auth']" })
    expect(real?.links[0]?.attributes).toEqual({ 'auth.header': "[Scrubbed due to 'auth']" })
  })

  it('scrubs instrumentation spans, late attributes, and events before export', async () => {
    const exporter = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({ spanProcessors: [new LogfireSpanProcessor(new SimpleSpanProcessor(exporter), undefined)] })
    const span = provider.getTracer('instrumentation').startSpan('GET /orders', {
      attributes: { 'http.request.header.authorization': 'Bearer abc', 'http.route': '/orders' },
    })
    span.setAttribute('db.password', 'hunter2')
    span.addEvent('retry', { note: 'session=abc' })
    span.recordException(new Error('invalid session token'))
    span.end()
    await provider.forceFlush()

    const [exported] = exporter.getFinishedSpans()
    expect(exported?.attributes).toEqual({
      'http.request.header.authorization': "[Scrubbed due to 'auth']",
      'http.route': '/orders',
      'db.password': "[Scrubbed due to 'password']",
      'logfire.scrubbed': JSON.stringify([
        { matched_substring: 'auth', path: ['attributes', 'http.request.header.authorization'] },
        { matched_substring: 'password', path: ['attributes', 'db.password'] },
        { matched_substring: 'session', path: ['otel_events', 0, 'attributes', 'note'] },
      ]),
    })
    expect(exported?.events[0]?.attributes).toEqual({ note: "[Scrubbed due to 'session']" })
    expect(exported?.events[1]?.attributes?.['exception.message']).toBe('invalid session token')
  })

  it('scrubs log record attributes and bodies before export', async () => {
    const exporter = new InMemoryLogRecordExporter()
    const provider = new LoggerProvider({ processors: [new ScrubbingLogRecordProcessor(new SimpleLogRecordProcessor(exporter))] })
    provider.getLogger('test').emit({ attributes: { 'user.cookie': 'abc', path: '/x' }, body: 'reset password for jane' })
    await provider.forceFlush()

    const [exported] = exporter.getFinishedLogRecords()
    expect(exported?.attributes).toEqual({
      'user.cookie': "[Scrubbed due to 'cookie']",
      path: '/x',
      'logfire.scrubbed': JSON.stringify([
        { matched_substring: 'cookie', path: ['attributes', 'user.cookie'] },
        { matched_substring: 'password', path: ['log_body'] },
      ]),
    })
    expect(exported?.body).toBe("[Scrubbed due to 'password']")
  })
})
