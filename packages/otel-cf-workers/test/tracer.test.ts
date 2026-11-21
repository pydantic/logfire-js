import { context, defaultTextMapSetter, ROOT_CONTEXT, trace } from '@opentelemetry/api'
import { CompositePropagator, W3CTraceContextPropagator } from '@opentelemetry/core'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { describe, expect, it } from 'vitest'

import { parseConfig, setConfig } from '../src/config'
import { BatchTraceSpanProcessor } from '../src/spanprocessor'
import { AsyncLocalStorageContextManager } from '../src/context'
import { ActiveConfigPropagator } from '../src/propagator'
import { WorkerTracer } from '../src/tracer'

context.setGlobalContextManager(new AsyncLocalStorageContextManager())

const exporterA = new InMemorySpanExporter()
const exporterB = new InMemorySpanExporter()
const configA = parseConfig({ service: { name: 'service-a' }, spanProcessors: [new SimpleSpanProcessor(exporterA)] })
const configB = parseConfig({
  propagator: new CompositePropagator(),
  service: { name: 'service-b' },
  spanProcessors: [new SimpleSpanProcessor(exporterB)],
})
const contextA = setConfig(configA, ROOT_CONTEXT)
const contextB = setConfig(configB, ROOT_CONTEXT)

describe('config captured in a context', () => {
  it('routes a span to the config of the context it was started from', () => {
    const tracer = new WorkerTracer()

    context.with(contextB, () => {
      tracer.startSpan('captured', {}, contextA).end()
    })

    expect(exporterA.getFinishedSpans().map((span) => span.name)).toEqual(['captured'])
    expect(exporterA.getFinishedSpans()[0]?.resource.attributes['service.name']).toBe('service-a')
    expect(exporterB.getFinishedSpans()).toEqual([])
  })

  it('injects with the propagator of the context being injected', () => {
    const propagator = new ActiveConfigPropagator(new W3CTraceContextPropagator())
    const spanContext = { spanId: 'b7ad6b7169203331', traceFlags: 1, traceId: '0af7651916cd43dd8448eb211c80319c' }
    const carrier: Record<string, string> = {}

    context.with(contextB, () => {
      propagator.inject(trace.setSpanContext(contextA, spanContext), carrier, defaultTextMapSetter)
    })

    expect(carrier).toEqual({ traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' })
  })

  it('exports a trace with the tail sampler and post-processor of the config it started under', async () => {
    const exporterC = new InMemorySpanExporter()
    const configC = parseConfig({
      postProcessor: (spans) => spans.map((span) => Object.assign(span, { name: `${span.name} (c)` })),
      service: { name: 'service-c' },
      spanProcessors: [new BatchTraceSpanProcessor(exporterC)],
    })
    const dropEverything = parseConfig({
      sampling: { tailSampler: () => false },
      service: { name: 'service-d' },
      spanProcessors: [],
    })
    const tracer = new WorkerTracer()
    const span = tracer.startSpan('started in c', {}, setConfig(configC, ROOT_CONTEXT))

    context.with(setConfig(dropEverything, ROOT_CONTEXT), () => {
      span.end()
    })
    await Promise.all(configC.spanProcessors.map(async (processor) => processor.forceFlush()))

    expect(exporterC.getFinishedSpans().map((finished) => finished.name)).toEqual(['started in c (c)'])
  })
})
