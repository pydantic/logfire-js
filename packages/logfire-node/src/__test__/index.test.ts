import { describe, expect, it } from 'vite-plus/test'

import logfireNode, { startPendingSpan, withSettings, withTags } from '../index'

describe('node default export', () => {
  it('re-exports startPendingSpan from the shared API', () => {
    expect(logfireNode.startPendingSpan).toBe(startPendingSpan)
  })

  it('re-exports scoped client helpers from the shared API', () => {
    expect(logfireNode.withSettings).toBe(withSettings)
    expect(logfireNode.withTags).toBe(withTags)
  })
})
