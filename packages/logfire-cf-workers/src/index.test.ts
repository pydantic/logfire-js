import { describe, expect, it } from 'vite-plus/test'
import { startPendingSpan, withSettings, withTags } from 'logfire'

import logfireCfWorkers from './index'

describe('cf-workers default export', () => {
  it('re-exports startPendingSpan from the shared API', () => {
    expect(logfireCfWorkers.startPendingSpan).toBe(startPendingSpan)
  })

  it('mirrors scoped client helpers on the default export', () => {
    expect(logfireCfWorkers.withSettings).toBe(withSettings)
    expect(logfireCfWorkers.withTags).toBe(withTags)
  })
})
