import { describe, expect, test } from 'vitest'

import { EvaluatorContext } from './evaluators/context'
import { CaseLifecycle } from './lifecycle'
import { SpanTreeRecordingError } from './otel/errors'

describe('CaseLifecycle', () => {
  test('default hooks are no-ops', async () => {
    class DefaultLc extends CaseLifecycle {}
    const caseObj = { evaluators: [], expectedOutput: null, inputs: 1, metadata: null, name: 'x' }
    const lc = new DefaultLc(caseObj)
    await expect(lc.setup()).resolves.toBeUndefined()
    const ctx = new EvaluatorContext({
      attributes: {},
      duration: 0,
      expectedOutput: null,
      inputs: 1,
      metadata: null,
      metrics: {},
      name: null,
      output: 1,
      spanTree: new SpanTreeRecordingError('no'),
    })
    await expect(lc.prepareContext(ctx)).resolves.toEqual(ctx)
    await expect(lc.teardown({ name: 'x' })).resolves.toBeUndefined()
    expect(lc.case).toBe(caseObj)
  })
})
