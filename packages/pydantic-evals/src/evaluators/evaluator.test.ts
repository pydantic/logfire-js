import { describe, expect, test } from 'vitest'

import { SpanTreeRecordingError } from '../otel/errors'
import { EvaluatorContext } from './context'
import { downcastEvaluationResult, evaluationReason, Evaluator, EvaluatorOutput, isEvaluationReason } from './evaluator'
import { runEvaluator } from './runEvaluator'
import { parseEvaluatorSpec, serializeEvaluatorSpec } from './spec'

class SimpleEval extends Evaluator {
  evaluate() {
    return true
  }
}

class ReasonEval extends Evaluator {
  evaluate() {
    return evaluationReason(true, 'because')
  }
}

class MappingEval extends Evaluator {
  evaluate(): EvaluatorOutput {
    return { a: true, b: evaluationReason(5, 'num') }
  }
}

class AsyncEval extends Evaluator {
  async evaluate() {
    await Promise.resolve()
    return true
  }
}

class WithFields extends Evaluator {
  readonly a: number
  readonly b: string
  constructor(params: { a: number; b: string }) {
    super()
    this.a = params.a
    this.b = params.b
  }
  evaluate() {
    return true
  }
}

const makeCtx = () =>
  new EvaluatorContext({
    attributes: {},
    duration: 0,
    expectedOutput: null,
    inputs: {},
    metadata: null,
    metrics: {},
    name: null,
    output: null,
    spanTree: new SpanTreeRecordingError('no'),
  })

describe('Evaluator', () => {
  test('evaluateAsync wraps sync evaluate', async () => {
    const ev = new SimpleEval()
    const r = await ev.evaluateAsync(makeCtx())
    expect(r).toBe(true)
  })

  test('evaluateAsync passes through async', async () => {
    const r = await new AsyncEval().evaluateAsync(makeCtx())
    expect(r).toBe(true)
  })

  test('getDefaultEvaluationName falls back to class name', () => {
    const ev = new SimpleEval()
    expect(ev.getDefaultEvaluationName()).toBe('SimpleEval')
  })

  test('getDefaultEvaluationName returns evaluationName if set', () => {
    const ev = new SimpleEval()
    ev.evaluationName = 'CustomName'
    expect(ev.getDefaultEvaluationName()).toBe('CustomName')
  })

  test('asSpec serializes arguments', () => {
    const ev = new WithFields({ a: 1, b: 'x' })
    const spec = ev.asSpec()
    expect(spec.name).toBe('WithFields')
    expect(spec.arguments).toEqual({ a: 1, b: 'x' })
  })

  test('asSpec null arguments when empty', () => {
    const ev = new SimpleEval()
    const spec = ev.asSpec()
    expect(spec.arguments).toBeNull()
  })

  test('isEvaluationReason detects shape', () => {
    expect(isEvaluationReason(evaluationReason(true))).toBe(true)
    expect(isEvaluationReason(null)).toBe(false)
    expect(isEvaluationReason({})).toBe(false)
    expect(isEvaluationReason({ value: true })).toBe(true)
    expect(isEvaluationReason({ value: Symbol() })).toBe(false)
  })

  test('downcastEvaluationResult distinguishes types', () => {
    const boolRes = { name: 'x', reason: null, source: { arguments: null, name: 'X' }, value: true }
    expect(downcastEvaluationResult(boolRes, 'boolean')?.value).toBe(true)
    const numRes = { name: 'x', reason: null, source: { arguments: null, name: 'X' }, value: 3 }
    expect(downcastEvaluationResult(numRes, 'number')?.value).toBe(3)
    expect(downcastEvaluationResult(numRes, 'boolean')).toBeNull()
    const strRes = { name: 'x', reason: null, source: { arguments: null, name: 'X' }, value: 'hi' }
    expect(downcastEvaluationResult(strRes, 'string')?.value).toBe('hi')
    expect(downcastEvaluationResult(strRes, 'number')).toBeNull()
  })
})

describe('runEvaluator', () => {
  test('returns EvaluationResult list', async () => {
    const r = await runEvaluator(new SimpleEval(), makeCtx())
    expect(Array.isArray(r)).toBe(true)
    if (Array.isArray(r)) {
      expect(r[0]?.name).toBe('SimpleEval')
      expect(r[0]?.value).toBe(true)
    }
  })

  test('returns EvaluatorFailure on error', async () => {
    class BoomEval extends Evaluator {
      evaluate(): never {
        throw new Error('kaboom')
      }
    }
    const r = await runEvaluator(new BoomEval(), makeCtx())
    expect(Array.isArray(r)).toBe(false)
    if (!Array.isArray(r)) {
      expect(r.errorMessage).toContain('kaboom')
    }
  })

  test('handles mapping output', async () => {
    const r = await runEvaluator(new MappingEval(), makeCtx())
    if (Array.isArray(r)) {
      expect(r).toHaveLength(2)
    }
  })

  test('handles reason output', async () => {
    const r = await runEvaluator(new ReasonEval(), makeCtx())
    if (Array.isArray(r)) {
      expect(r[0]?.reason).toBe('because')
    }
  })
})

describe('parseEvaluatorSpec', () => {
  test('parses string form', () => {
    expect(parseEvaluatorSpec('Eval')).toEqual({ arguments: null, name: 'Eval' })
  })

  test('parses named with positional arg array', () => {
    expect(parseEvaluatorSpec({ Eval: [1] })).toEqual({ arguments: [1], name: 'Eval' })
  })

  test('parses named with kwargs', () => {
    expect(parseEvaluatorSpec({ Eval: { a: 1 } })).toEqual({ arguments: { a: 1 }, name: 'Eval' })
  })

  test('parses named with scalar arg', () => {
    expect(parseEvaluatorSpec({ Eval: 5 } as unknown as Record<string, [number]>)).toEqual({ arguments: [5], name: 'Eval' })
  })

  test('throws for multi-key object', () => {
    expect(() => parseEvaluatorSpec({ A: [1], B: [2] } as unknown as Record<string, [number]>)).toThrow()
  })

  test('throws for positional with not exactly 1 element', () => {
    expect(() => parseEvaluatorSpec({ Eval: [1, 2] } as unknown as Record<string, [number]>)).toThrow()
  })

  test('serializeEvaluatorSpec returns string for null args', () => {
    expect(serializeEvaluatorSpec({ arguments: null, name: 'Eval' })).toBe('Eval')
  })

  test('serializeEvaluatorSpec returns object for non-null args', () => {
    expect(serializeEvaluatorSpec({ arguments: [1], name: 'Eval' })).toEqual({ Eval: [1] })
  })
})
