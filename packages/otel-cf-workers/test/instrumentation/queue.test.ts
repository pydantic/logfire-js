/// <reference types="@cloudflare/workers-types/experimental" />

import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { beforeEach, describe, expect, it, vitest } from 'vitest'
import { context, SpanStatusCode, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '../../src/context'
import { executeQueueHandler, instrumentQueueSender } from '../../src/instrumentation/queue'
import type { QueueHandlerArgs } from '../../src/instrumentation/queue'

const exporter = new InMemorySpanExporter()

const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})

trace.setGlobalTracerProvider(provider)
context.setGlobalContextManager(new AsyncLocalStorageContextManager())

const sendMock = vitest.fn<() => Promise<void>>()
const sendBatchMock = vitest.fn<() => Promise<void>>()
const queue = { send: sendMock, sendBatch: sendBatchMock } as unknown as Queue

beforeEach(() => {
  exporter.reset()
  vitest.resetAllMocks()
})

describe('queue sender instrumentation', () => {
  it('ends the span for a successful send', async () => {
    const instrument = instrumentQueueSender(queue, 'my-queue')
    await expect(instrument.send('body')).resolves.toBe(undefined)

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0]?.name).toBe('Queues my-queue send')
    expect(spans[0]?.attributes['queue.operation']).toBe('send')
    expect(spans[0]?.status.code).toBe(SpanStatusCode.UNSET)
  })

  it('ends the span and records the error when a send rejects', async () => {
    const error = new Error('send failed')
    sendMock.mockRejectedValue(error)

    const instrument = instrumentQueueSender(queue, 'my-queue')
    await expect(instrument.send('body')).rejects.toBe(error)

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0]?.name).toBe('Queues my-queue send')
    expect(spans[0]?.status).toEqual({ code: SpanStatusCode.ERROR })
    expect(spans[0]?.events.map((event) => event.name)).toEqual(['exception'])
    expect(spans[0]?.events[0]?.attributes?.['exception.message']).toBe('send failed')
  })

  it('ends the span and records the error when a sendBatch rejects', async () => {
    const error = new Error('sendBatch failed')
    sendBatchMock.mockRejectedValue(error)

    const instrument = instrumentQueueSender(queue, 'my-queue')
    await expect(instrument.sendBatch([{ body: 'one' }])).rejects.toBe(error)

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0]?.name).toBe('Queues my-queue sendBatch')
    expect(spans[0]?.attributes['queue.operation']).toBe('sendBatch')
    expect(spans[0]?.status).toEqual({ code: SpanStatusCode.ERROR })
    expect(spans[0]?.events.map((event) => event.name)).toEqual(['exception'])
  })
})

describe('queue consumer instrumentation', () => {
  function createBatch(): QueueHandlerArgs[0] {
    return { queue: 'my-queue', messages: [] } as unknown as QueueHandlerArgs[0]
  }

  function createExecutionContext(): QueueHandlerArgs[2] {
    return {
      passThroughOnException: () => undefined,
      props: {},
      waitUntil: () => undefined,
    } as unknown as QueueHandlerArgs[2]
  }

  it('ends the span without an error status when the handler succeeds', async () => {
    const queueFn = vitest.fn<() => Promise<void>>().mockResolvedValue(undefined)

    await executeQueueHandler(queueFn as unknown as ExportedHandlerQueueHandler, [createBatch(), {}, createExecutionContext()])

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0]?.name).toBe('queueHandler my-queue')
    expect(spans[0]?.status.code).toBe(SpanStatusCode.UNSET)
  })

  it('marks the span as an error when the handler throws', async () => {
    const error = new Error('consumer boom')
    const queueFn = vitest.fn<() => Promise<void>>().mockRejectedValue(error)

    await expect(
      executeQueueHandler(queueFn as unknown as ExportedHandlerQueueHandler, [createBatch(), {}, createExecutionContext()])
    ).rejects.toBe(error)

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0]?.name).toBe('queueHandler my-queue')
    expect(spans[0]?.status).toEqual({ code: SpanStatusCode.ERROR })
    expect(spans[0]?.events.map((event) => event.name)).toEqual(['exception'])
    expect(spans[0]?.events[0]?.attributes?.['exception.message']).toBe('consumer boom')
  })
})
