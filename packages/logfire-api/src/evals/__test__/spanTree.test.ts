/* eslint-disable @typescript-eslint/require-await */
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'

import { trace as TraceAPI } from '@opentelemetry/api'
import { describe, expect, it } from 'vite-plus/test'

import { Case, Dataset, HasMatchingSpan, SpanTree, SpanTreeRecordingError } from '../../evals'
import { withMemoryExporter } from './withMemoryExporter'

const fakeSpan = (opts: {
  attributes?: Record<string, unknown>
  durationMs?: number
  name: string
  parentSpanId?: string
  spanId: string
  startMs?: number
}): ReadableSpan =>
  ({
    attributes: opts.attributes ?? {},
    endTime: [0, ((opts.startMs ?? 0) + (opts.durationMs ?? 1)) * 1_000_000],
    name: opts.name,
    parentSpanContext:
      opts.parentSpanId === undefined
        ? undefined
        : { isRemote: false, spanId: opts.parentSpanId, traceFlags: 1, traceId: 'trace000000000000000000000001' },
    spanContext: () => ({ isRemote: false, spanId: opts.spanId, traceFlags: 1, traceId: 'trace000000000000000000000001' }),
    startTime: [0, (opts.startMs ?? 0) * 1_000_000],
  }) as unknown as ReadableSpan

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

  it('builds deterministic trees and evaluates structural span queries', () => {
    const tree = SpanTree.fromSpans([
      fakeSpan({
        attributes: { child: true, route: '/slow' },
        durationMs: 20,
        name: 'child-slow',
        parentSpanId: 'root',
        spanId: 'b',
        startMs: 20,
      }),
      fakeSpan({
        attributes: { child: true, route: '/fast' },
        durationMs: 3,
        name: 'child-fast',
        parentSpanId: 'root',
        spanId: 'a',
        startMs: 10,
      }),
      fakeSpan({ attributes: { leaf: true }, durationMs: 1, name: 'leaf', parentSpanId: 'a', spanId: 'leaf', startMs: 12 }),
      fakeSpan({ attributes: { root: true }, durationMs: 50, name: 'root-op', spanId: 'root', startMs: 0 }),
    ])

    expect(tree.roots.map((node) => node.name)).toEqual(['root-op'])
    expect(tree.roots[0]?.children.map((node) => node.name)).toEqual(['child-fast', 'child-slow'])
    expect(Array.from(tree.all()).map((node) => node.name)).toEqual(['root-op', 'child-fast', 'leaf', 'child-slow'])

    expect(tree.any({ minChildCount: 2, minDescendantCount: 3, nameContains: 'root' })).toBe(true)
    expect(tree.any({ maxDuration: 5, nameMatchesRegex: '^child-' })).toBe(true)
    expect(tree.any({ max_duration: 0.004, name_equals: 'child-fast' })).toBe(true)
    expect(tree.any({ max_duration: 0.002, name_equals: 'child-fast' })).toBe(false)
    expect(tree.any({ hasAttributes: { route: '/fast' }, nameEquals: 'child-fast' })).toBe(true)
    expect(tree.any({ hasAttributeKeys: ['leaf'], someAncestorHas: { nameEquals: 'root-op' } })).toBe(true)
    expect(tree.any({ allChildrenHave: { nameContains: 'child' }, nameEquals: 'root-op' })).toBe(true)
    expect(tree.any({ allDescendantsHave: { maxDuration: 20 }, nameEquals: 'root-op' })).toBe(true)
    expect(tree.any({ max_depth: 0, name_equals: 'root-op' })).toBe(true)
    expect(tree.any({ min_depth: 2, name_equals: 'leaf' })).toBe(true)
    expect(tree.any({ name_equals: 'root-op', no_child_has: { name_equals: 'leaf' } })).toBe(true)
    expect(tree.any({ name_equals: 'root-op', no_descendant_has: { name_equals: 'missing' } })).toBe(true)
    expect(tree.any({ name_equals: 'leaf', no_ancestor_has: { name_equals: 'missing' } })).toBe(true)
    expect(tree.any({ and_: [{ nameContains: 'child' }, { not_: { nameContains: 'slow' } }] })).toBe(true)
    expect(tree.any({ or_: [{ nameEquals: 'missing' }, { nameEquals: 'leaf' }] })).toBe(true)
    expect(() => tree.any({ name_equals: 'leaf', or_: [{ name_equals: 'leaf' }] })).toThrow(
      "Cannot combine 'or_' conditions with other conditions at the same level"
    )

    expect(tree.find({ someDescendantHas: { nameEquals: 'leaf' } }).map((node) => node.name)).toEqual(['root-op', 'child-fast'])
    expect(
      tree.any({
        name_equals: 'root-op',
        some_descendant_has: { name_equals: 'leaf' },
        stop_recursing_when: { name_equals: 'child-fast' },
      })
    ).toBe(false)
    expect(tree.first({ maxChildCount: 0 })?.name).toBe('leaf')
    expect(tree.any({ hasAttributes: { route: '/missing' } })).toBe(false)
    expect(tree.any({ hasAttributeKeys: ['missing'] })).toBe(false)
    expect(tree.any({ maxChildCount: 1, nameEquals: 'root-op' })).toBe(false)
    expect(tree.any({ maxDescendantCount: 2, nameEquals: 'root-op' })).toBe(false)
  })

  it('serializes HasMatchingSpan queries with snake_case field names', () => {
    expect(new HasMatchingSpan({ query: { maxDuration: 0.1, someChildHas: { nameEquals: 'child' } } }).toJSON()).toEqual({
      query: {
        max_duration: 0.1,
        some_child_has: { name_equals: 'child' },
      },
    })
  })

  it('throws the stored recording error when querying an unavailable tree', () => {
    const err = new SpanTreeRecordingError('capture unavailable')
    const tree = SpanTree.fromError(err)

    expect(() => {
      tree.ensureAvailable()
    }).toThrow(err)
    expect(() => {
      tree.find({ nameEquals: 'x' })
    }).toThrow(err)
    expect(() => {
      tree.first({ nameEquals: 'x' })
    }).toThrow(err)
  })
})
