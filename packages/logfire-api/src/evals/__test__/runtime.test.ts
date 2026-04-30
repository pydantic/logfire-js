import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { detectRuntime, hasAsyncLocalStorage, hasNodeFs } from '../../evals'

describe('runtime detection', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('detects Node, Bun and Deno before generic browser runtimes', () => {
    expect(detectRuntime()).toBe('node')
    expect(hasAsyncLocalStorage()).toBe(true)
    expect(hasNodeFs()).toBe(true)

    vi.stubGlobal('Bun', {})
    expect(detectRuntime()).toBe('bun')
    expect(hasAsyncLocalStorage()).toBe(true)
    expect(hasNodeFs()).toBe(true)

    vi.stubGlobal('Bun', undefined)
    vi.stubGlobal('Deno', { readTextFile: async () => Promise.resolve(''), writeTextFile: async () => Promise.resolve() })
    expect(detectRuntime()).toBe('deno')
    expect(hasAsyncLocalStorage()).toBe(true)
    expect(hasNodeFs()).toBe(true)
  })

  it('detects workers and browsers when process-style runtimes are absent', () => {
    vi.stubGlobal('Bun', undefined)
    vi.stubGlobal('Deno', undefined)
    vi.stubGlobal('process', undefined)
    vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' })
    expect(detectRuntime()).toBe('workers')
    expect(hasAsyncLocalStorage()).toBe(true)
    expect(hasNodeFs()).toBe(false)

    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0' })
    expect(detectRuntime()).toBe('browser')
    expect(hasAsyncLocalStorage()).toBe(false)
    expect(hasNodeFs()).toBe(false)
  })
})
