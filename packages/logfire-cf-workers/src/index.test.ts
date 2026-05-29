import { describe, expect, it } from 'vite-plus/test'
import { instrument as instrumentFunction, startPendingSpan, withSettings, withTags } from 'logfire'

import logfireCfWorkers, { instrument as instrumentWorker } from './index'

describe('cf-workers default export', () => {
  it('keeps instrument as the Cloudflare runtime helper', () => {
    const defaultInstrument = Object.getOwnPropertyDescriptor(logfireCfWorkers, 'instrument')?.value as typeof instrumentWorker

    expect(defaultInstrument).toBe(instrumentWorker)
    expect(defaultInstrument).not.toBe(instrumentFunction)
  })

  it('re-exports startPendingSpan from the shared API', () => {
    expect(logfireCfWorkers.startPendingSpan).toBe(startPendingSpan)
  })

  it('mirrors scoped client helpers on the default export', () => {
    expect(logfireCfWorkers.withSettings).toBe(withSettings)
    expect(logfireCfWorkers.withTags).toBe(withTags)
  })
})
