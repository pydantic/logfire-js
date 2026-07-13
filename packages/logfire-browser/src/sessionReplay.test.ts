import { diag } from '@opentelemetry/api'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { BrowserSessionManager } from './browserSession'
import { BrowserSessionReplayState, startBrowserSessionReplay } from './sessionReplay'
import type { BrowserSessionReplayModule, BrowserSessionReplayPackageConfig, BrowserSessionReplayRuntime } from './sessionReplay'

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>()

  get length(): number {
    return this.items.size
  }

  clear(): void {
    this.items.clear()
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null
  }

  key(index: number): string | null {
    return Array.from(this.items.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.items.delete(key)
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value)
  }
}

function createManager(): BrowserSessionManager {
  return new BrowserSessionManager({
    generateId: () => 'browser-session-1',
    now: () => 1_000,
    storage: new MemoryStorage(),
    storageKey: 'test-session',
  })
}

function createReplayRuntime(overrides: Partial<BrowserSessionReplayRuntime> = {}): BrowserSessionReplayRuntime {
  let stopCalls = 0
  return {
    mode: 'full',
    recording: true,
    flush: async () => Promise.resolve(),
    getSessionId: () => 'browser-session-1',
    stop: async () => {
      stopCalls += 1
      await Promise.resolve()
    },
    ...overrides,
    get stopCalls() {
      return stopCalls
    },
  } as BrowserSessionReplayRuntime & { readonly stopCalls: number }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('startBrowserSessionReplay', () => {
  it('loads replay, passes browser-owned config, and uses peekSessionId on the hot path', async () => {
    const manager = createManager()
    const touchSpy = vi.spyOn(manager, 'touch')
    const getSessionSpy = vi.spyOn(manager, 'getSession')
    let replayConfig: BrowserSessionReplayPackageConfig | undefined
    const replayRuntime = createReplayRuntime()
    const replayModule: BrowserSessionReplayModule = {
      startSessionReplay: vi.fn<(config: BrowserSessionReplayPackageConfig) => BrowserSessionReplayRuntime>((config) => {
        replayConfig = config
        return replayRuntime
      }),
    }
    const headers = () => ({ 'X-CSRF': 'csrf-token' })
    const getDistinctId = () => 'user-1'
    const fetchImpl = vi.fn<typeof fetch>()
    const onError = vi.fn<(error: unknown) => void>()
    const replayState = new BrowserSessionReplayState()

    const replay = await startBrowserSessionReplay(
      {
        blockSelector: '.private',
        captureConsole: false,
        captureNavigation: false,
        captureNetwork: true,
        distinctId: 'static-user',
        fetchImpl,
        flushIntervalMs: 2_000,
        getDistinctId,
        headers,
        ignoreUrlPatterns: [/\/custom-ignore/u],
        load: () => replayModule,
        maskAllInputs: false,
        maskTextSelector: '.secret',
        maxBufferBytes: 123_456,
        onError,
        onErrorSampleRate: 0.5,
        redactUrlPatterns: [/\/redact/u],
        replayUrl: '/logfire/replay',
        sessionSampleRate: 0.25,
        token: 'direct-token',
      },
      manager,
      replayState,
      {
        metricUrl: '/logfire/metrics',
        traceUrl: '/logfire/traces',
      }
    )

    expect(replay).toBeDefined()
    expect(replayState.getState()).toEqual({ active: true, mode: 'full' })
    expect(replayConfig).toMatchObject({
      blockSelector: '.private',
      captureConsole: false,
      captureNavigation: false,
      captureNetwork: true,
      distinctId: 'static-user',
      fetchImpl,
      flushIntervalMs: 2_000,
      getDistinctId,
      headers,
      maskAllInputs: false,
      maskTextSelector: '.secret',
      maxBufferBytes: 123_456,
      onErrorSampleRate: 0.5,
      redactUrlPatterns: [/\/redact/u],
      replayUrl: '/logfire/replay',
      sessionSampleRate: 0.25,
      token: 'direct-token',
    })
    expect(replayConfig).not.toHaveProperty('getTraceContext')
    expect(replayConfig).not.toHaveProperty('sessionIdleTimeoutMs')
    expect(replayConfig).not.toHaveProperty('maxSessionDurationMs')
    const reportedError = new Error('reported by replay')
    replayConfig?.onError?.(reportedError)
    expect(onError).toHaveBeenCalledWith(reportedError)
    expect(replayConfig?.ignoreUrlPatterns?.some((pattern) => pattern.test('/logfire/traces'))).toBe(true)
    expect(replayConfig?.ignoreUrlPatterns?.some((pattern) => pattern.test('/logfire/metrics'))).toBe(true)
    expect(replayConfig?.ignoreUrlPatterns?.some((pattern) => pattern.test('/logfire/replay/browser-session-1?seq=0'))).toBe(true)
    expect(replayConfig?.ignoreUrlPatterns?.some((pattern) => pattern.test('/custom-ignore'))).toBe(true)

    expect(touchSpy).toHaveBeenCalledTimes(1)
    expect(replayConfig?.getSessionId?.()).toBe('browser-session-1')
    expect(replayConfig?.getSessionId?.()).toBe('browser-session-1')
    expect(touchSpy).toHaveBeenCalledTimes(1)
    expect(getSessionSpy).not.toHaveBeenCalled()
  })

  it('clears replay state when the wrapped replay is stopped once', async () => {
    const replayState = new BrowserSessionReplayState()
    let stopCalls = 0
    const replayModule: BrowserSessionReplayModule = {
      startSessionReplay: () =>
        createReplayRuntime({
          stop: async () => {
            stopCalls += 1
            return Promise.resolve()
          },
        }),
    }

    const replay = await startBrowserSessionReplay(
      { load: () => replayModule, replayUrl: '/logfire/replay' },
      createManager(),
      replayState,
      { traceUrl: '/logfire/traces' }
    )

    expect(replayState.getState()).toEqual({ active: true, mode: 'full' })
    await replay?.stop()
    await replay?.stop()
    expect(stopCalls).toBe(1)
    expect(replayState.getState()).toBeUndefined()
  })

  it('keeps dynamic replay state while sampling moves from off to active and back', async () => {
    const replayState = new BrowserSessionReplayState()
    let mode: BrowserSessionReplayRuntime['mode'] = 'off'
    let recording = false
    const runtime: BrowserSessionReplayRuntime = {
      get mode() {
        return mode
      },
      get recording() {
        return recording
      },
      flush: async () => Promise.resolve(),
      getSessionId: () => 'browser-session-1',
      stop: async () => Promise.resolve(),
    }
    const replayModule: BrowserSessionReplayModule = {
      startSessionReplay: () => runtime,
    }

    const replay = await startBrowserSessionReplay(
      { load: () => replayModule, replayUrl: '/logfire/replay' },
      createManager(),
      replayState,
      { traceUrl: '/logfire/traces' }
    )

    expect(replay?.mode).toBe('off')
    expect(replayState.getState()).toBeUndefined()
    mode = 'buffer'
    recording = true
    expect(replayState.getState()).toEqual({ active: true, mode: 'buffer' })
    mode = 'off'
    recording = false
    expect(replayState.getState()).toBeUndefined()
    await replay?.stop()
  })

  it('reports startup failures without throwing', async () => {
    const diagError = vi.spyOn(diag, 'error').mockImplementation(() => undefined)
    const onError = vi.fn<(error: unknown) => void>()
    const replayState = new BrowserSessionReplayState()
    replayState.setReplay(createReplayRuntime())
    const error = new Error('missing peer')

    const replay = await startBrowserSessionReplay(
      {
        load: async () => Promise.reject(error),
        onError,
        replayUrl: '/logfire/replay',
      },
      createManager(),
      replayState,
      { traceUrl: '/logfire/traces' }
    )

    expect(replay).toBeUndefined()
    expect(replayState.getState()).toBeUndefined()
    expect(diagError).toHaveBeenCalledWith(expect.stringContaining('failed to start session replay'), error)
    expect(onError).toHaveBeenCalledWith(error)
  })

  it.each(['', '/', '/logfire/replay?token=x', '/logfire/replay#fragment'])(
    'contains invalid browser replay URL %s before loading the optional package',
    async (replayUrl) => {
      const diagError = vi.spyOn(diag, 'error').mockImplementation(() => undefined)
      const load = vi.fn<() => BrowserSessionReplayModule>()
      const onError = vi.fn<(error: unknown) => void>()

      await expect(
        startBrowserSessionReplay({ load, onError, replayUrl }, createManager(), new BrowserSessionReplayState(), {
          traceUrl: '/logfire/traces',
        })
      ).resolves.toBeUndefined()

      expect(load).not.toHaveBeenCalled()
      expect(onError).toHaveBeenCalledTimes(1)
      const reportedError = onError.mock.calls[0]?.[0]
      expect(reportedError).toBeInstanceOf(Error)
      expect((reportedError as Error).message).toContain('replayUrl')
      expect(diagError).toHaveBeenCalledWith(expect.stringContaining('failed to start session replay'), expect.any(Error))
    }
  )

  it('does not let a throwing startup error callback reject replay startup handling', async () => {
    const diagError = vi.spyOn(diag, 'error').mockImplementation(() => undefined)
    const error = new Error('missing peer')

    await expect(
      startBrowserSessionReplay(
        {
          load: async () => Promise.reject(error),
          onError: () => {
            throw new Error('consumer callback failed')
          },
          replayUrl: '/logfire/replay',
        },
        createManager(),
        new BrowserSessionReplayState(),
        { traceUrl: '/logfire/traces' }
      )
    ).resolves.toBeUndefined()
    expect(diagError).toHaveBeenCalledWith(expect.stringContaining('failed to start session replay'), error)
  })

  it('contains hostile runtime getters and rejected browser error reporters', async () => {
    const onError = vi.fn<() => void>(() => Promise.reject(new Error('reporter failed')) as unknown as void)
    const replayState = new BrowserSessionReplayState()
    const replay = await startBrowserSessionReplay(
      {
        load: () => ({
          startSessionReplay: () => ({
            get mode(): 'full' | 'buffer' | 'off' {
              throw new Error('mode unavailable')
            },
            get recording(): boolean {
              throw new Error('recording unavailable')
            },
            flush: async () => Promise.reject(new Error('flush failed')),
            getSessionId: () => {
              throw new Error('session unavailable')
            },
            stop: async () => Promise.reject(new Error('stop failed')),
          }),
        }),
        onError,
        replayUrl: '/logfire/replay',
      },
      createManager(),
      replayState,
      { traceUrl: '/logfire/traces' }
    )

    expect(replay).toBeDefined()
    expect(() => replay?.mode).not.toThrow()
    expect(() => replay?.recording).not.toThrow()
    expect(() => replay?.getSessionId()).not.toThrow()
    await expect(replay?.flush()).resolves.toBeUndefined()
    await expect(replay?.stop()).resolves.toBeUndefined()
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
    expect(onError).toHaveBeenCalled()
  })
})
