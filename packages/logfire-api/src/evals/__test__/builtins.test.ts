/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from 'vite-plus/test'

import { Contains, deepEqual, Equals, EqualsExpected, IsInstance, LLMJudge, MaxDuration, SpanTree } from '../../evals'
import type { EvaluatorContext } from '../../evals'

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
      value: true,
    })
    expect(new Contains({ caseSensitive: false, value: 'needle' }).evaluate(ctx('haystack'))).toMatchObject({ value: false })
    expect(new Contains({ asStrings: true, value: 23 }).evaluate(ctx(12345))).toEqual({
      value: true,
    })
    expect(new Contains({ value: { ok: true } }).evaluate(ctx([{ ok: false }, { ok: true }]))).toEqual({
      value: true,
    })
    expect(new Contains({ value: 'missing' }).evaluate(ctx(['present']))).toMatchObject({ value: false })
    expect(new Contains({ value: 'status' }).evaluate(ctx({ status: 'ok' }))).toEqual({
      value: true,
    })
    expect(new Contains({ value: { status: 'ok' } }).evaluate(ctx({ extra: true, status: 'ok' }))).toEqual({ value: true })
    expect(new Contains({ value: 'ok' }).evaluate(ctx({ status: 'ok' }))).toMatchObject({ value: false })
    expect(new Contains({ value: 'missing' }).evaluate(ctx({ status: 'ok' }))).toMatchObject({ value: false })
    expect(new Contains({ value: 'x' }).evaluate(ctx(123))).toEqual({
      reason: 'Containment check failed: output is not iterable',
      value: false,
    })
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

  it('deepEqual compares the contents of Dates, RegExps, Sets and Maps', () => {
    // A task returns these in process, so they are not constrained by the dataset file format.
    expect(deepEqual(new Date('2020-01-01'), new Date('1990-01-01'))).toBe(false)
    expect(deepEqual(new Date('2020-01-01'), new Date('2020-01-01'))).toBe(true)
    expect(deepEqual(new Date(0), new Map())).toBe(false)
    expect(deepEqual(new Date(0), { getTime: 0 })).toBe(false)
    expect(deepEqual(/a/gu, /b/gu)).toBe(false)
    expect(deepEqual(/a/gu, /a/gu)).toBe(true)
    expect(deepEqual(/a/gu, /a/u)).toBe(false)
    expect(deepEqual(new Set([1]), new Set([2]))).toBe(false)
    expect(deepEqual(new Set([1]), new Set([1, 2]))).toBe(false)
    expect(deepEqual(new Set([1, 'a']), new Set([1, 'a']))).toBe(true)
    expect(deepEqual(new Map([['a', 1]]), new Map([['a', 2]]))).toBe(false)
    expect(deepEqual(new Map([['a', 1]]), new Map([['b', 1]]))).toBe(false)
    expect(
      deepEqual(
        new Map([['a', 1]]),
        new Map([
          ['a', 1],
          ['b', 2],
        ])
      )
    ).toBe(false)
    expect(deepEqual(new Map([['a', undefined]]), new Map([['b', undefined]]))).toBe(false)
    expect(deepEqual(new Map([['a', { n: 1 }]]), new Map([['a', { n: 1 }]]))).toBe(true)
  })

  it('EqualsExpected reports a wrong Date as a failure', () => {
    const evaluator = new EqualsExpected()
    expect(evaluator.evaluate(ctx(new Date('2020-01-01'), { expectedOutput: new Date('1990-01-01') }))).toBe(false)
    expect(evaluator.evaluate(ctx(new Date('2020-01-01'), { expectedOutput: new Date('2020-01-01') }))).toBe(true)
  })

  it('Equals and EqualsExpected preserve custom result names and empty-output behavior', () => {
    const eq = new Equals({ evaluationName: 'exact', value: { nested: ['x'] } })
    expect(eq.getResultName()).toBe('exact')
    expect(eq.toJSON()).toEqual({ evaluation_name: 'exact', value: { nested: ['x'] } })
    expect(eq.evaluate(ctx({ nested: ['x'] }))).toBe(true)
    expect(new Equals({ value: 'completely-different-type' }).evaluate(ctx({ x: 1 }))).toBe(false)

    const expected = new EqualsExpected({ evaluationName: 'expected-match' })
    expect(expected.toJSON()).toEqual({ evaluation_name: 'expected-match' })
    expect(expected.evaluate(ctx('x'))).toEqual({})
    // A dataset file spells a missing expected output as `null`, which Python skips on.
    expect(expected.evaluate(ctx('x', { expectedOutput: null }))).toEqual({})
    expect(expected.evaluate(ctx('x', { expectedOutput: 'x' }))).toBe(true)
  })

  it('an evaluator can read undefined expected_output and metadata from the context', () => {
    class NullProbe extends class {
      evaluate(_c: EvaluatorContext): { has_expected_output: boolean; has_metadata: boolean } {
        return { has_expected_output: _c.expectedOutput !== undefined, has_metadata: _c.metadata !== undefined }
      }
    } {}
    const result = new NullProbe().evaluate(ctx('out'))
    expect(result).toEqual({ has_expected_output: false, has_metadata: false })
    const enriched = new NullProbe().evaluate(ctx('out', { expectedOutput: 'x', metadata: { k: 1 } }))
    expect(enriched).toEqual({ has_expected_output: true, has_metadata: true })
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
    expect(judge.toJSON()).toEqual({
      assertion: { evaluation_name: 'judge_assertion' },
      include_expected_output: true,
      include_input: true,
      rubric: 'grade it',
      score: { evaluation_name: 'judge_score', include_reason: true },
    })

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
      score: {},
    })
    await expect(scoreOnly.evaluate(ctx('actual'))).resolves.toEqual({ LLMJudge: 1 })

    const bothDefaults = new LLMJudge({
      judge: () => ({ pass: true, reason: 'ok', score: 0.8 }),
      rubric: 'both',
      score: {},
    })
    await expect(bothDefaults.evaluate(ctx('actual'))).resolves.toEqual({
      LLMJudge_pass: { reason: 'ok', value: true },
      LLMJudge_score: 0.8,
    })
  })

  it('Contains does not leave a lone surrogate when truncating a reason', () => {
    // repr is '"' + value + '"' and the string limit is 100, so the head cut lands
    // at repr index 50, putting an emoji's halves either side of it.
    const head = `${'a'.repeat(48)}\u{1F600}${'b'.repeat(80)}`
    // The tail cut lands 50 units from the end, on the low half of this emoji.
    const tail = `${'a'.repeat(80)}\u{1F600}${'b'.repeat(48)}`

    for (const value of [head, tail]) {
      const result = new Contains({ value: 'ZZZNOTFOUND' }).evaluate(ctx(value)) as { reason?: string; value: boolean }

      // The containment has to actually fail, otherwise there is no reason to check.
      expect(result.value).toBe(false)
      expect(typeof result.reason).toBe('string')

      const reason = result.reason as string
      // A lone surrogate has no UTF-8 encoding, so encoding replaces it with
      // U+FFFD and the round trip stops matching.
      expect(new TextDecoder().decode(new TextEncoder().encode(reason))).toBe(reason)
    }
  })
})
