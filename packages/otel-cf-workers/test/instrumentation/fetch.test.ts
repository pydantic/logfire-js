import type { Span, Tracer } from '@opentelemetry/api'
import { trace } from '@opentelemetry/api'
import { describe, expect, it, vitest } from 'vitest'
import { waitUntilTrace } from '../../src/instrumentation/fetch'

describe('waitUntilTrace', () => {
  it('ends the span when traced background work rejects', async () => {
    const error = new Error('background work failed')
    const end = vitest.fn<() => void>()
    const span = { end } as unknown as Span
    const tracer = {
      async startActiveSpan(_name: string, fn: (span: Span) => Promise<void>) {
        return fn(span)
      },
    } as unknown as Tracer
    const getTracer = vitest.spyOn(trace, 'getTracer').mockReturnValue(tracer)

    try {
      await expect(waitUntilTrace(async () => Promise.reject(error))).rejects.toBe(error)
      expect(end).toHaveBeenCalledTimes(1)
    } finally {
      getTracer.mockRestore()
    }
  })
})
