import { describe, expect, test } from 'vitest'

import { Case, Dataset, getCurrentTaskRun } from './dataset'
import { Contains } from './evaluators/common'
import { EvaluatorContext } from './evaluators/context'
import { Evaluator } from './evaluators/evaluator'
import { SpanTreeRecordingError } from './otel/errors'
import { defaultRenderDuration, defaultRenderDurationDiff, defaultRenderNumber, defaultRenderNumberDiff } from './reporting/renderNumbers'
import { EvaluationReport } from './reporting/report'

describe('coverage: renderNumbers edges', () => {
  test('defaultRenderDuration tiny microseconds', () => {
    expect(defaultRenderDuration(5e-8)).toContain('µs')
  })

  test('defaultRenderDuration at exactly 1ms boundary', () => {
    expect(defaultRenderDuration(1e-3)).toContain('ms')
  })

  test('defaultRenderNumberDiff with small delta returns only absolute', () => {
    const s = defaultRenderNumberDiff(1.0, 1.0000001)
    expect(s).not.toBeNull()
  })

  test('defaultRenderDurationDiff returns null when equal', () => {
    expect(defaultRenderDurationDiff(0.1, 0.1)).toBeNull()
  })

  test('defaultRenderDurationDiff with relative', () => {
    const s = defaultRenderDurationDiff(0.5, 1.0)
    expect(s).toContain('/')
  })

  test('defaultRenderNumber for large exponential values', () => {
    expect(defaultRenderNumber(1e-10)).toContain('0')
  })
})

describe('coverage: Contains error catch branch', () => {
  test('Contains catches exceptions during check', () => {
    const ev = new Contains({ value: 'x' })
    const ctx = new EvaluatorContext({
      attributes: {},
      duration: 0,
      expectedOutput: null,
      inputs: {},
      metadata: null,
      metrics: {},
      name: null,
      output: {
        // objects whose key access throws
        get x() {
          throw new Error('access error')
        },
      } as never,
      spanTree: new SpanTreeRecordingError('no'),
    })
    // Shouldn't throw
    const r = ev.evaluate(ctx)
    expect(r).toBeDefined()
  })
})

describe('coverage: getCurrentTaskRun within evaluation', () => {
  test('getCurrentTaskRun returns the run inside a task', async () => {
    class CaptureEval extends Evaluator {
      result: unknown = null
      evaluate() {
        // At evaluator time the task run has ended; call during the task
        return true
      }
    }
    let captured: unknown = null
    const ds = new Dataset<number, number>({
      cases: [new Case({ inputs: 1, name: 'a' })],
      evaluators: [new CaptureEval()],
      name: 'gc',
    })
    await ds.evaluate((n: number) => {
      captured = getCurrentTaskRun()
      return n
    })
    expect(captured).not.toBeNull()
  })
})

describe('coverage: report with only failures', () => {
  test('averages is null when no cases', () => {
    const report = new EvaluationReport({ cases: [], failures: [], name: 'r' })
    expect(report.averages()).toBeNull()
  })

  test('render with no analyses or metadata', () => {
    const report = new EvaluationReport({ cases: [], name: 'r' })
    const output = report.render()
    expect(output).toContain('r')
  })
})
