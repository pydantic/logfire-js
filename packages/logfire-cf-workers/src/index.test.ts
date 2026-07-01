import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vite-plus/test'
import { instrument as instrumentFunction, startPendingSpan, withSettings, withTags } from 'logfire'
import * as packageRoot from '@pydantic/logfire-cf-workers'

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

  it('publishes esm-only package metadata', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, Record<string, string>>
    }

    expect(packageRoot.instrument).toBeTypeOf('function')
    expect(packageRoot.instrumentDO).toBeTypeOf('function')
    expect(packageRoot.default.instrument).toBe(packageRoot.instrument)
    expect(packageRoot.default.instrumentDO).toBe(packageRoot.instrumentDO)
    expect(packageJson.exports['.']).not.toHaveProperty('require')
    expect(packageJson.exports['.']?.['default']).toBe('./dist/index.js')
    expect(packageJson.exports['.']?.['types']).toBe('./dist/index.d.ts')
    expect(readdirSync(new URL('../dist', import.meta.url)).sort()).toEqual(['index.d.ts', 'index.js'])
  })
})
