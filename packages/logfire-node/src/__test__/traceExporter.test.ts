import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { LogfireConsoleSpanExporter } from '../LogfireConsoleSpanExporter'
import { logfireConfig } from '../logfireConfig'
import { logfireSpanProcessor } from '../traceExporter'

describe('logfire span processor lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('still shuts the batch processor down when the console one fails, and reports both failures', async () => {
    // The batch processor is what holds spans that have not reached the exporter yet, so skipping
    // its shutdown drops every span still queued.
    Object.assign(logfireConfig, { sendToLogfire: false })
    vi.spyOn(LogfireConsoleSpanExporter.prototype, 'shutdown').mockRejectedValue(new Error('console down'))
    const batchShutdown = vi.spyOn(BatchSpanProcessor.prototype, 'shutdown').mockResolvedValue()

    const processor = logfireSpanProcessor(true)
    await expect(processor.shutdown()).rejects.toThrow('console down')
    expect(batchShutdown.mock.calls.length).toBe(1)

    // A lone failure is rethrown unchanged, so both failing raises them together instead of
    // silently keeping only the first.
    vi.spyOn(LogfireConsoleSpanExporter.prototype, 'forceFlush').mockRejectedValue(new Error('console flush down'))
    const batchFlush = vi.spyOn(BatchSpanProcessor.prototype, 'forceFlush').mockRejectedValue(new Error('batch flush down'))

    const raised: unknown = await logfireSpanProcessor(true)
      .forceFlush()
      .then(() => undefined)
      .catch((error: unknown) => error)

    expect(batchFlush.mock.calls.length).toBe(1)
    expect(raised).toBeInstanceOf(AggregateError)
    expect((raised as AggregateError).errors.map((error: Error) => error.message)).toEqual(['console flush down', 'batch flush down'])
  })
})
