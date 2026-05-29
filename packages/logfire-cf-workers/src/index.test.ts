import { describe, expect, it } from 'vite-plus/test'
import { startPendingSpan } from 'logfire'

import logfireCfWorkers from './index'

describe('cf-workers default export', () => {
  it('re-exports startPendingSpan from the shared API', () => {
    expect(logfireCfWorkers.startPendingSpan).toBe(startPendingSpan)
  })
})
