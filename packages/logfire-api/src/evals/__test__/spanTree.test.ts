/* eslint-disable @typescript-eslint/require-await */
import { trace as TraceAPI } from '@opentelemetry/api'
import { describe, expect, it } from 'vitest'

import { Case, Dataset, HasMatchingSpan } from '../../evals'
import { withMemoryExporter } from './withMemoryExporter'

describe('span tree capture + HasMatchingSpan', () => {
  it('captures user-task spans into ctx.spanTree and matches with HasMatchingSpan', async () => {
    const dataset = new Dataset<string, string>({
      cases: [new Case<string, string>({ inputs: 'hello', name: 'simple' })],
      evaluators: [new HasMatchingSpan({ query: { nameEquals: 'inner-op' } })],
      name: 'span-tree-test',
    })

    const { result } = await withMemoryExporter(async () =>
      dataset.evaluate(async (input) => {
        const tracer = TraceAPI.getTracer('user-code')
        await tracer.startActiveSpan('inner-op', async (span) => {
          span.setAttribute('user.input', input)
          span.end()
        })
        return input.toUpperCase()
      })
    )

    expect(result.cases).toHaveLength(1)
    const assertion = result.cases[0]?.assertions.HasMatchingSpan
    expect(assertion).toBeDefined()
    expect(assertion?.value).toBe(true)
  })

  it('returns false when no matching span exists', async () => {
    const dataset = new Dataset<string, string>({
      cases: [new Case<string, string>({ inputs: 'hi', name: 'no-match' })],
      evaluators: [new HasMatchingSpan({ query: { nameEquals: 'never-emitted' } })],
      name: 'span-tree-no-match',
    })

    const { result } = await withMemoryExporter(async () => dataset.evaluate((input) => input.toUpperCase()))

    expect(result.cases[0]?.assertions.HasMatchingSpan?.value).toBe(false)
  })

  it('extracts gen_ai.usage.* metrics from the span tree onto ctx.metrics', async () => {
    const dataset = new Dataset<null, string>({
      cases: [new Case<null, string>({ inputs: null, name: 'usage' })],
      name: 'usage-metrics-test',
    })

    const { result } = await withMemoryExporter(async () =>
      dataset.evaluate(async () => {
        const tracer = TraceAPI.getTracer('user-llm')
        await tracer.startActiveSpan('chat', async (span) => {
          span.setAttribute('gen_ai.request.model', 'gpt-4')
          span.setAttribute('gen_ai.operation.name', 'chat')
          span.setAttribute('gen_ai.usage.input_tokens', 100)
          span.setAttribute('gen_ai.usage.output_tokens', 50)
          span.setAttribute('operation.cost', 0.001)
          span.end()
        })
        return 'done'
      })
    )

    const m = result.cases[0]?.metrics
    expect(m?.requests).toBe(1)
    expect(m?.input_tokens).toBe(100)
    expect(m?.output_tokens).toBe(50)
    expect(m?.cost).toBeCloseTo(0.001)
  })
})
