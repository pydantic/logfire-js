import { describe, expect, test } from 'vitest'

import { ConfusionMatrixEvaluator, KolmogorovSmirnovEvaluator, PrecisionRecallEvaluator, ROCAUCEvaluator } from './reportCommon'
import { ReportEvaluatorContext } from './reportEvaluator'

const spec = (name: string) => ({ arguments: null, name })

function makeCtx(
  cases: {
    assertions?: Record<string, { reason: null; source: { arguments: null; name: string }; value: boolean }>
    expectedOutput?: unknown
    labels?: Record<string, { reason: null; source: { arguments: null; name: string }; value: string }>
    metadata?: unknown
    metrics?: Record<string, number>
    output?: unknown
    scores?: Record<string, { reason: null; source: { arguments: null; name: string }; value: number }>
  }[],
  name = 'exp'
): ReportEvaluatorContext {
  return {
    experimentMetadata: null,
    name,
    report: {
      cases: cases.map((c, i) => ({
        assertions: c.assertions ?? {},
        expectedOutput: c.expectedOutput ?? null,
        inputs: {},
        labels: c.labels ?? {},
        metadata: c.metadata ?? null,
        metrics: c.metrics ?? {},
        name: `c${String(i)}`,
        output: c.output ?? null,
        scores: c.scores ?? {},
      })),
    },
  } as unknown as ReportEvaluatorContext
}

describe('ConfusionMatrixEvaluator', () => {
  test('maps output vs expected', () => {
    const ev = new ConfusionMatrixEvaluator()
    const r = ev.evaluate(
      makeCtx([
        { expectedOutput: 'A', output: 'A' },
        { expectedOutput: 'A', output: 'B' },
        { expectedOutput: 'B', output: 'B' },
      ])
    )
    expect(r.classLabels).toEqual(['A', 'B'])
    expect(r.matrix[0]).toEqual([1, 1])
  })

  test('labels extraction', () => {
    const ev = new ConfusionMatrixEvaluator({ expectedFrom: 'labels', expectedKey: 'gt', predictedFrom: 'labels', predictedKey: 'pred' })
    const r = ev.evaluate(
      makeCtx([
        {
          labels: {
            gt: { reason: null, source: spec('X'), value: 'A' },
            pred: { reason: null, source: spec('X'), value: 'A' },
          },
        },
      ])
    )
    expect(r.classLabels).toEqual(['A'])
  })

  test('labels missing key throws', () => {
    const ev = new ConfusionMatrixEvaluator({ predictedFrom: 'labels' })
    expect(() => ev.evaluate(makeCtx([{}]))).toThrow(/key/)
  })

  test('metadata extraction with key', () => {
    const ev = new ConfusionMatrixEvaluator({
      expectedFrom: 'metadata',
      expectedKey: 'gt',
      predictedFrom: 'metadata',
      predictedKey: 'pred',
    })
    const r = ev.evaluate(makeCtx([{ metadata: { gt: 'A', pred: 'A' } }]))
    expect(r.classLabels).toEqual(['A'])
  })

  test('metadata extraction without key', () => {
    const ev = new ConfusionMatrixEvaluator({
      expectedFrom: 'metadata',
      predictedFrom: 'metadata',
    })
    const r = ev.evaluate(makeCtx([{ metadata: 'A' }]))
    expect(r.classLabels).toEqual(['A'])
  })

  test('skips when key is missing on dict metadata', () => {
    const ev = new ConfusionMatrixEvaluator({ predictedFrom: 'metadata', predictedKey: 'missing' })
    const r = ev.evaluate(makeCtx([{ metadata: { other: 1 } }]))
    expect(r.matrix).toEqual([])
  })

  test('reports serialization name', () => {
    const ev = new ConfusionMatrixEvaluator()
    expect(ev.getSerializationName()).toBe('ConfusionMatrixEvaluator')
    expect(ev.asSpec().name).toBe('ConfusionMatrixEvaluator')
  })
})

describe('PrecisionRecallEvaluator', () => {
  test('empty data produces NaN auc', () => {
    const ev = new PrecisionRecallEvaluator({ positiveFrom: 'expected_output', scoreKey: 'x' })
    const r = ev.evaluate(makeCtx([]))
    expect(r).toHaveLength(2)
  })

  test('populated data produces non-empty curves', () => {
    const ev = new PrecisionRecallEvaluator({ positiveFrom: 'expected_output', scoreKey: 's' })
    const cases = [
      { expectedOutput: true, scores: { s: { reason: null, source: spec('E'), value: 0.9 } } },
      { expectedOutput: false, scores: { s: { reason: null, source: spec('E'), value: 0.4 } } },
      { expectedOutput: true, scores: { s: { reason: null, source: spec('E'), value: 0.7 } } },
    ]
    const [pr] = ev.evaluate(makeCtx(cases))
    expect(pr?.type).toBe('precision_recall')
  })

  test('metrics score source', () => {
    const ev = new PrecisionRecallEvaluator({ positiveFrom: 'expected_output', scoreFrom: 'metrics', scoreKey: 's' })
    const r = ev.evaluate(
      makeCtx([
        { expectedOutput: true, metrics: { s: 0.9 } },
        { expectedOutput: false, metrics: { s: 0.1 } },
      ])
    )
    expect(r[0]?.type).toBe('precision_recall')
  })

  test('assertions/labels source', () => {
    const ev = new PrecisionRecallEvaluator({ positiveFrom: 'assertions', positiveKey: 'a', scoreKey: 's' })
    const r = ev.evaluate(
      makeCtx([
        {
          assertions: { a: { reason: null, source: spec('E'), value: true } },
          scores: { s: { reason: null, source: spec('E'), value: 0.9 } },
        },
      ])
    )
    expect(r).toHaveLength(2)
  })

  test('assertions requires positiveKey', () => {
    const ev = new PrecisionRecallEvaluator({ positiveFrom: 'assertions', scoreKey: 's' })
    expect(() => ev.evaluate(makeCtx([{ assertions: { a: { reason: null, source: spec('E'), value: true } } }]))).toThrow()
  })

  test('labels source', () => {
    const ev = new PrecisionRecallEvaluator({ positiveFrom: 'labels', positiveKey: 'l', scoreKey: 's' })
    const r = ev.evaluate(
      makeCtx([
        {
          labels: { l: { reason: null, source: spec('E'), value: 'yes' } },
          scores: { s: { reason: null, source: spec('E'), value: 0.9 } },
        },
      ])
    )
    expect(r).toHaveLength(2)
  })

  test('downsample with nThresholds=1 returns full points', () => {
    const ev = new PrecisionRecallEvaluator({ nThresholds: 1, positiveFrom: 'expected_output', scoreKey: 's' })
    const r = ev.evaluate(
      makeCtx([
        { expectedOutput: true, scores: { s: { reason: null, source: spec('E'), value: 0.9 } } },
        { expectedOutput: false, scores: { s: { reason: null, source: spec('E'), value: 0.1 } } },
      ])
    )
    expect(r).toHaveLength(2)
  })
})

describe('ROCAUCEvaluator', () => {
  test('empty data', () => {
    const ev = new ROCAUCEvaluator({ positiveFrom: 'expected_output', scoreKey: 's' })
    const r = ev.evaluate(makeCtx([]))
    expect(r).toHaveLength(2)
  })

  test('only positives returns empty result', () => {
    const ev = new ROCAUCEvaluator({ positiveFrom: 'expected_output', scoreKey: 's' })
    const r = ev.evaluate(
      makeCtx([
        { expectedOutput: true, scores: { s: { reason: null, source: spec('E'), value: 0.9 } } },
        { expectedOutput: true, scores: { s: { reason: null, source: spec('E'), value: 0.8 } } },
      ])
    )
    expect(r).toHaveLength(2)
  })

  test('balanced data produces curve', () => {
    const ev = new ROCAUCEvaluator({ positiveFrom: 'expected_output', scoreKey: 's' })
    const r = ev.evaluate(
      makeCtx([
        { expectedOutput: true, scores: { s: { reason: null, source: spec('E'), value: 0.9 } } },
        { expectedOutput: false, scores: { s: { reason: null, source: spec('E'), value: 0.1 } } },
      ])
    )
    expect(r[0]?.type).toBe('line_plot')
  })
})

describe('KolmogorovSmirnovEvaluator', () => {
  test('empty data', () => {
    const ev = new KolmogorovSmirnovEvaluator({ positiveFrom: 'expected_output', scoreKey: 's' })
    const r = ev.evaluate(makeCtx([]))
    expect(r).toHaveLength(2)
  })

  test('only positives', () => {
    const ev = new KolmogorovSmirnovEvaluator({ positiveFrom: 'expected_output', scoreKey: 's' })
    const r = ev.evaluate(makeCtx([{ expectedOutput: true, scores: { s: { reason: null, source: spec('E'), value: 0.9 } } }]))
    expect(r).toHaveLength(2)
  })

  test('produces curves', () => {
    const ev = new KolmogorovSmirnovEvaluator({ positiveFrom: 'expected_output', scoreKey: 's' })
    const r = ev.evaluate(
      makeCtx([
        { expectedOutput: true, scores: { s: { reason: null, source: spec('E'), value: 0.9 } } },
        { expectedOutput: false, scores: { s: { reason: null, source: spec('E'), value: 0.1 } } },
      ])
    )
    expect(r[0]?.type).toBe('line_plot')
    expect(r[1]?.type).toBe('scalar')
  })
})
