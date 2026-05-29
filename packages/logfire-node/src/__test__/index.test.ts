import { describe, expect, it } from 'vite-plus/test'

import logfireNode, { startPendingSpan } from '../index'

describe('node default export', () => {
  it('re-exports startPendingSpan from the shared API', () => {
    expect(logfireNode.startPendingSpan).toBe(startPendingSpan)
  })
})
