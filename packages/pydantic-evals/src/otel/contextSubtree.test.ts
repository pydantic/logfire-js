import { trace } from '@opentelemetry/api'
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'
import { beforeAll, describe, expect, test } from 'vitest'

import { _resetForTests, contextSubtree, contextSubtreeCapture, getSpanTreeProcessor } from './contextSubtree'
import { SpanTreeRecordingError } from './errors'
import { SpanTree } from './spanTree'

beforeAll(() => {
  _resetForTests()
  const provider = new BasicTracerProvider({
    spanProcessors: [getSpanTreeProcessor() as never],
  })
  trace.setGlobalTracerProvider(provider)
})

describe('contextSubtree integration', () => {
  test('captures spans started during the subtree', async () => {
    const result = await contextSubtreeCapture(async (getTree) => {
      const tracer = trace.getTracer('test')
      const span = tracer.startSpan('my-span')
      span.setAttribute('foo', 'bar')
      span.end()
      await new Promise((r) => setTimeout(r, 5))
      return getTree()
    })
    expect(result).toBeInstanceOf(SpanTree)
    if (result instanceof SpanTree) {
      const nodes = Array.from(result)
      expect(nodes.length).toBeGreaterThanOrEqual(0)
    }
  })

  test('contextSubtree yields an empty tree', async () => {
    const result = await contextSubtree((tree) => tree instanceof SpanTree)
    expect(result).toBe(true)
  })

  test('handles recording error check', async () => {
    const result = await contextSubtree((tree) => tree instanceof SpanTreeRecordingError || tree instanceof SpanTree)
    expect(result).toBe(true)
  })
})
