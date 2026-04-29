/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from 'vitest'

import {
  Contains,
  deepEqual,
  Equals,
  EqualsExpected,
  type EvaluatorContext,
  IsInstance,
  LLMJudge,
  MaxDuration,
  SpanTree,
} from '../../evals'

const ctx = (output: unknown, extra: Partial<EvaluatorContext> = {}): EvaluatorContext => ({
  attributes: {},
  duration: 0,
  inputs: undefined,
  metrics: {},
  name: 'case',
  output,
  spanTree: new SpanTree(),
  ...extra,
})

describe('built-in evaluator edge cases', () => {
  it('Contains supports strings, arrays, objects, asStrings and non-iterables', () => {
    expect(new Contains({ caseSensitive: false, value: 'needle' }).evaluate(ctx('A NEEDLE appears'))).toEqual({
      reason: 'output contains value',
      value: true,
    })
    expect(new Contains({ caseSensitive: false, value: 'needle' }).evaluate(ctx('haystack'))).toEqual({
      reason: 'output does not contain value',
      value: false,
    })
    expect(new Contains({ asStrings: true, value: 23 }).evaluate(ctx(12345))).toEqual({
      reason: 'output contains value',
      value: true,
    })
    expect(new Contains({ value: { ok: true } }).evaluate(ctx([{ ok: false }, { ok: true }]))).toEqual({
      reason: 'value found in output array',
      value: true,
    })
    expect(new Contains({ value: 'missing' }).evaluate(ctx(['present']))).toEqual({
      reason: 'value not found in output array',
      value: false,
    })
    expect(new Contains({ value: 'status' }).evaluate(ctx({ status: 'ok' }))).toEqual({
      reason: 'key matches value',
      value: true,
    })
    expect(new Contains({ value: 'ok' }).evaluate(ctx({ status: 'ok' }))).toEqual({
      reason: 'object value matches',
      value: true,
    })
    expect(new Contains({ value: 'missing' }).evaluate(ctx({ status: 'ok' }))).toEqual({
      reason: 'value not found in object',
      value: false,
    })
    expect(new Contains({ value: 'x' }).evaluate(ctx(123))).toEqual({ reason: 'output is not iterable', value: false })
  })

  it('deepEqual covers primitive, array and object mismatches', () => {
    expect(deepEqual(1, 1)).toBe(true)
    expect(deepEqual(1, '1')).toBe(false)
    expect(deepEqual(null, {})).toBe(false)
    expect(deepEqual({ a: 1 }, 1)).toBe(false)
    expect(deepEqual([1, { a: true }], [1, { a: true }])).toBe(true)
    expect(deepEqual([1], [1, 2])).toBe(false)
    expect(deepEqual([1], ['1'])).toBe(false)
    expect(deepEqual([1], { 0: 1 })).toBe(false)
    expect(deepEqual({ a: 1 }, { a: 1 })).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false)
  })

  it('Equals and EqualsExpected preserve custom result names and empty-output behavior', () => {
    const eq = new Equals({ evaluationName: 'exact', value: { nested: ['x'] } })
    expect(eq.getResultName()).toBe('exact')
    expect(eq.toJSON()).toEqual({ evaluation_name: 'exact', value: { nested: ['x'] } })
    expect(eq.evaluate(ctx({ nested: ['x'] }))).toBe(true)

    const expected = new EqualsExpected({ evaluationName: 'expected-match' })
    expect(expected.toJSON()).toEqual({ evaluation_name: 'expected-match' })
    expect(expected.evaluate(ctx('x'))).toEqual({})
    expect(expected.evaluate(ctx('x', { expectedOutput: 'x' }))).toBe(true)
  })

  it('IsInstance handles nullish values, class ancestry and primitive fallbacks', () => {
    class Base {
      base = true
    }
    class Child extends Base {}

    expect(new IsInstance({ typeName: 'Child' }).evaluate(ctx(new Child()))).toEqual({
      reason: 'output is instance of Child',
      value: true,
    })
    expect(new IsInstance({ typeName: 'Base' }).evaluate(ctx(new Child()))).toEqual({
      reason: 'output is instance of Base',
      value: true,
    })
    expect(new IsInstance({ typeName: 'string' }).evaluate(ctx('x'))).toEqual({
      reason: 'output typeof matches string',
      value: true,
    })
    expect(new IsInstance({ typeName: 'Date' }).evaluate(ctx('x'))).toEqual({
      reason: 'output is not instance of Date',
      value: false,
    })
    expect(new IsInstance({ typeName: 'Thing' }).evaluate(ctx(null))).toEqual({ reason: 'output is null', value: false })
    expect(new IsInstance({ typeName: 'Thing' }).evaluate(ctx(undefined))).toEqual({
      reason: 'output is undefined',
      value: false,
    })
  })

  it('MaxDuration compares against the recorded task duration', () => {
    expect(new MaxDuration({ seconds: 1 }).evaluate(ctx('x', { duration: 0.5 }))).toBe(true)
    expect(new MaxDuration({ seconds: 1 }).evaluate(ctx('x', { duration: 1.5 }))).toBe(false)
  })

  it('LLMJudge requires a judge callback and maps score/assertion channels', async () => {
    await expect(new LLMJudge({ rubric: 'be good' }).evaluate(ctx('x'))).rejects.toThrow('LLMJudge: no judge callback provided')

    const judge = new LLMJudge({
      assertion: { evaluationName: 'judge_assertion', includeReason: false },
      includeExpectedOutput: true,
      includeInput: true,
      judge: async (args) => {
        expect(args).toEqual({
          expectedOutput: 'expected',
          inputs: { prompt: 'p' },
          output: 'actual',
          rubric: 'grade it',
        })
        return { pass: true, reason: 'solid', score: 0.9 }
      },
      rubric: 'grade it',
      score: { evaluationName: 'judge_score', includeReason: true },
    })

    await expect(judge.evaluate(ctx('actual', { expectedOutput: 'expected', inputs: { prompt: 'p' } }))).resolves.toEqual({
      judge_assertion: true,
      judge_score: { reason: 'solid', value: 0.9 },
    })
    expect(judge.toJSON()).toEqual({ include_expected_output: true, include_input: true, rubric: 'grade it' })

    const assertionOnly = new LLMJudge({
      judge: () => ({ pass: false, reason: 'nope', score: 0.1 }),
      rubric: 'assert only',
      score: false,
    })
    await expect(assertionOnly.evaluate(ctx('actual'))).resolves.toEqual({
      LLMJudge: { reason: 'nope', value: false },
    })

    const scoreOnly = new LLMJudge({
      assertion: false,
      judge: () => ({ pass: true, score: 1 }),
      rubric: 'score only',
    })
    await expect(scoreOnly.evaluate(ctx('actual'))).resolves.toEqual({ LLMJudge: 1 })
  })
})
