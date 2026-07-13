/**
 * @vitest-environment jsdom
 */
/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/require-await, no-empty-function, vitest/require-mock-type-parameters */
import { gunzipSync, strFromU8 } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import * as captureMod from './capture'
import { startSessionReplay } from './index'
import * as recorderMod from './recorder'
import { CHUNK_ENVELOPE_VERSION, CustomTag, EventType, IncrementalSource, MouseInteractions } from './types'
import type { ChunkEnvelope, RrwebEvent, SessionReplayConfig } from './types'

let captured: recorderMod.RecorderOptions
let handle: {
  stop: Mock<() => void>
  addCustomEvent: Mock<(tag: string, payload: unknown) => void>
  takeFullSnapshot: Mock<() => void>
}
let handles: (typeof handle)[]

const fullSnapshot: RrwebEvent = { type: EventType.FullSnapshot, data: { node: {} }, timestamp: 1 }
const click: RrwebEvent = {
  type: EventType.IncrementalSnapshot,
  data: { source: IncrementalSource.MouseInteraction, type: MouseInteractions.Click },
  timestamp: 2,
}

function emit(event: RrwebEvent): void {
  captured.emit(event)
}

beforeEach(() => {
  sessionStorage.clear()
  handles = []
  vi.spyOn(recorderMod, 'startRecording').mockImplementation((options) => {
    captured = options
    handle = {
      stop: vi.fn<() => void>(),
      addCustomEvent: vi.fn<(tag: string, payload: unknown) => void>(),
      takeFullSnapshot: vi.fn<() => void>(),
    }
    handles.push(handle)
    return handle
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('startSessionReplay environment and sampling gates', () => {
  it('is a no-op in non-browser environments', () => {
    const { calls, fetchImpl } = recordingFetch()
    const start = vi.spyOn(recorderMod, 'startRecording')
    vi.stubGlobal('window', undefined)
    vi.stubGlobal('document', undefined)

    const replay = startSessionReplay(baseConfig(fetchImpl))

    expect(replay.recording).toBe(false)
    expect(replay.mode).toBe('off')
    expect(replay.getSessionId()).toBe('')
    expect(start).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it("keeps a lightweight controller when sampling resolves to 'off'", async () => {
    const { fetchImpl } = recordingFetch()
    const start = vi.spyOn(recorderMod, 'startRecording')
    const replay = startSessionReplay(baseConfig(fetchImpl, { sessionSampleRate: 0, onErrorSampleRate: 0, random: () => 0.99 }))
    expect(replay.recording).toBe(false)
    expect(replay.mode).toBe('off')
    expect(start).not.toHaveBeenCalled()
    await replay.stop()
  })

  it('keeps sampling mode stable across page loads for the same session id', async () => {
    const { fetchImpl } = recordingFetch()
    const firstReplay = startSessionReplay(
      baseConfig(fetchImpl, {
        getSessionId: () => 'external-session',
        onErrorSampleRate: 0,
        random: () => 0.1,
        sessionSampleRate: 0.5,
      })
    )
    expect(firstReplay.mode).toBe('full')
    await firstReplay.stop()

    const random = vi.fn(() => 0.99)
    const secondReplay = startSessionReplay(
      baseConfig(fetchImpl, {
        getSessionId: () => 'external-session',
        onErrorSampleRate: 0,
        random,
        sessionSampleRate: 0.5,
      })
    )

    expect(secondReplay.mode).toBe('full')
    expect(random).not.toHaveBeenCalled()
    await secondReplay.stop()
  })

  it('persists off sampling decisions for the same session id', async () => {
    const { fetchImpl } = recordingFetch()
    const firstReplay = startSessionReplay(
      baseConfig(fetchImpl, {
        getSessionId: () => 'sampled-out-session',
        onErrorSampleRate: 0,
        random: () => 0.99,
        sessionSampleRate: 0.5,
      })
    )
    expect(firstReplay.mode).toBe('off')
    await firstReplay.stop()

    const random = vi.fn(() => 0)
    const secondReplay = startSessionReplay(
      baseConfig(fetchImpl, {
        getSessionId: () => 'sampled-out-session',
        onErrorSampleRate: 0,
        random,
        sessionSampleRate: 0.5,
      })
    )

    expect(secondReplay.mode).toBe('off')
    expect(random).not.toHaveBeenCalled()
    await secondReplay.stop()
  })
})

describe('startSessionReplay controller ownership', () => {
  it('rejects a second active controller without disturbing the owner and releases on stop', async () => {
    const { fetchImpl } = recordingFetch()
    const first = startSessionReplay(baseConfig(fetchImpl))

    expect(() => startSessionReplay(baseConfig(fetchImpl))).toThrow(
      'logfire session replay: a replay controller is already active in this page'
    )
    expect(handles[0]!.stop).not.toHaveBeenCalled()

    await first.stop()
    const next = startSessionReplay(baseConfig(fetchImpl))
    expect(next.recording).toBe(true)
    await next.stop()
  })

  it('holds the page lease while the current session is sampled off', async () => {
    const { fetchImpl } = recordingFetch()
    const first = startSessionReplay(baseConfig(fetchImpl, { sessionSampleRate: 0, onErrorSampleRate: 0, random: () => 1 }))

    expect(first.recording).toBe(false)
    expect(() => startSessionReplay(baseConfig(fetchImpl))).toThrow(/controller is already active/u)

    await first.stop()
    const next = startSessionReplay(baseConfig(fetchImpl))
    await next.stop()
  })

  it('coordinates duplicate module instances through the shared page lease', async () => {
    const { fetchImpl } = recordingFetch()
    const first = startSessionReplay(baseConfig(fetchImpl, { sessionSampleRate: 0, onErrorSampleRate: 0, random: () => 1 }))
    vi.resetModules()
    const duplicateModule = await import('./index')

    expect(() => duplicateModule.startSessionReplay(baseConfig(fetchImpl))).toThrow(/controller is already active/u)
    await first.stop()
  })

  it('releases the lease and installed resources after initial setup failure', async () => {
    const { fetchImpl } = recordingFetch()
    const stopConsole = vi.fn<() => void>()
    vi.spyOn(captureMod, 'captureConsole').mockReturnValue(stopConsole)
    vi.spyOn(captureMod, 'captureNetwork').mockImplementationOnce(() => {
      throw new Error('network capture setup failed')
    })

    expect(() =>
      startSessionReplay(baseConfig(fetchImpl, { captureConsole: true, captureNetwork: true, captureNavigation: false }))
    ).toThrow('network capture setup failed')
    expect(handles[0]!.stop).toHaveBeenCalledTimes(1)
    expect(stopConsole).toHaveBeenCalledTimes(1)

    const next = startSessionReplay(baseConfig(fetchImpl))
    await next.stop()
  })

  it('releases the lease when rrweb returns no usable recorder stop handle', async () => {
    const { fetchImpl } = recordingFetch()
    vi.mocked(recorderMod.startRecording).mockImplementationOnce(() => {
      throw new Error('logfire session replay: rrweb failed to start recording')
    })

    expect(() => startSessionReplay(baseConfig(fetchImpl))).toThrow('logfire session replay: rrweb failed to start recording')

    const next = startSessionReplay(baseConfig(fetchImpl))
    expect(next.recording).toBe(true)
    await next.stop()
  })

  it('retains the lease after a later activation failure and retries only for a new session', async () => {
    vi.useFakeTimers()
    let sessionId = 'session-a'
    const { fetchImpl } = recordingFetch()
    const replay = startSessionReplay(baseConfig(fetchImpl, { getSessionId: () => sessionId }))
    vi.mocked(recorderMod.startRecording).mockImplementationOnce(() => {
      throw new Error('later recorder failure')
    })

    sessionId = 'session-b'
    await vi.advanceTimersByTimeAsync(1_000)
    await replay.flush()
    expect(replay.recording).toBe(false)
    expect(() => startSessionReplay(baseConfig(fetchImpl))).toThrow(/controller is already active/u)

    sessionId = 'session-c'
    await vi.advanceTimersByTimeAsync(1_000)
    await replay.flush()
    expect(replay.recording).toBe(true)
    await replay.stop()
  })
})

describe('startSessionReplay full mode', () => {
  it('flushes a chunk through the proxy URL and returns an internal session id', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const replay = startSessionReplay(baseConfig(fetchImpl))
    expect(replay.mode).toBe('full')
    emit(fullSnapshot)
    emit(click)
    await replay.flush()

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`https://app.example.com/replay/${replay.getSessionId()}?seq=0`)
    const envelope = decodeBody(calls[0]!.init.body)
    expect(envelope.version).toBe(CHUNK_ENVELOPE_VERSION)
    expect(envelope.events).toHaveLength(2)
    expect(envelope.meta.clickCount).toBe(1)
    await replay.stop()
  })

  it('passes checkoutEveryNms=0 to the recorder in full mode', async () => {
    const { fetchImpl } = recordingFetch()
    const replay = startSessionReplay(baseConfig(fetchImpl))
    expect(captured.checkoutEveryNms).toBe(0)
    await replay.stop()
  })

  it('uses getDistinctId per flush', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const replay = startSessionReplay(baseConfig(fetchImpl, { getDistinctId: () => 'signed-in-user' }))
    emit(fullSnapshot)
    await replay.flush()
    expect(decodeBody(calls[0]!.init.body).meta.distinctId).toBe('signed-in-user')
    await replay.stop()
  })

  it('uses external getSessionId and creates a fresh runtime when it changes', async () => {
    let sessionId = 'external-1'
    const { calls, fetchImpl } = recordingFetch()
    const start = vi.spyOn(recorderMod, 'startRecording')
    const replay = startSessionReplay(baseConfig(fetchImpl, { getSessionId: () => sessionId }))
    expect(replay.getSessionId()).toBe('external-1')
    emit(fullSnapshot)

    sessionId = 'external-2'
    emit(click)
    expect(replay.recording).toBe(false)
    await replay.flush()
    expect(replay.recording).toBe(true)
    expect(start).toHaveBeenCalledTimes(2)
    emit(fullSnapshot)
    await replay.flush()
    await replay.stop()

    expect(calls.map((call) => call.url)).toEqual([
      'https://app.example.com/replay/external-1?seq=0',
      'https://app.example.com/replay/external-2?seq=0',
    ])
  })

  it('starts interval flushing in full mode', async () => {
    vi.useFakeTimers()
    const { fetchImpl } = recordingFetch()
    const setSpy = vi.spyOn(globalThis, 'setInterval')
    const replay = startSessionReplay(baseConfig(fetchImpl))
    expect(setSpy.mock.calls.map((call) => call[1])).toContain(5_000)
    await replay.stop()
  })

  it('resolves sampling independently when external sessions rotate through full, off, and buffer', async () => {
    vi.useFakeTimers()
    let sessionId = 'session-full'
    const { fetchImpl } = recordingFetch()
    const replay = startSessionReplay(
      baseConfig(fetchImpl, {
        getSessionId: () => sessionId,
        sessionSampleRate: 0.5,
        onErrorSampleRate: 0.5,
        random: rng([0.1, 0.9, 0.9, 0.9, 0.1]),
      })
    )
    expect(replay.mode).toBe('full')

    sessionId = 'session-off'
    await vi.advanceTimersByTimeAsync(1_000)
    await replay.flush()
    expect(replay.mode).toBe('off')
    expect(replay.recording).toBe(false)

    sessionId = 'session-buffer'
    await vi.advanceTimersByTimeAsync(1_000)
    await replay.flush()
    expect(replay.mode).toBe('buffer')
    expect(replay.recording).toBe(true)
    await replay.stop()
  })

  it('resolves sampling independently when internal sessions expire through full, off, and buffer', async () => {
    vi.useFakeTimers()
    let now = 0
    const { fetchImpl } = recordingFetch()
    const replay = startSessionReplay(
      baseConfig(fetchImpl, {
        maxSessionDurationMs: 10_000,
        now: () => now,
        onErrorSampleRate: 0.5,
        random: rng([0.1, 0.9, 0.9, 0.9, 0.1]),
        sessionIdleTimeoutMs: 100,
        sessionSampleRate: 0.5,
      })
    )
    const fullSessionId = replay.getSessionId()
    expect(replay.mode).toBe('full')

    now = 200
    await vi.advanceTimersByTimeAsync(1_000)
    await replay.flush()
    const offSessionId = replay.getSessionId()
    expect(offSessionId).not.toBe(fullSessionId)
    expect(replay.mode).toBe('off')
    expect(replay.recording).toBe(false)

    now = 400
    await vi.advanceTimersByTimeAsync(1_000)
    await replay.flush()
    expect(replay.getSessionId()).not.toBe(offSessionId)
    expect(replay.mode).toBe('buffer')
    expect(replay.recording).toBe(true)
    await replay.stop()
  })
})

describe('startSessionReplay correlation and errors', () => {
  it('stamps trace context only when trace id changes', async () => {
    vi.useFakeTimers()
    const { fetchImpl } = recordingFetch()
    const traces = ['A', 'A', 'B']
    let index = 0
    const replay = startSessionReplay(
      baseConfig(fetchImpl, { getTraceContext: () => ({ traceId: traces[index++] ?? '', spanId: 'span' }) })
    )

    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(handle.addCustomEvent.mock.calls.filter((call) => call[0] === CustomTag.Trace)).toEqual([
      [CustomTag.Trace, { traceId: 'A', spanId: 'span' }],
      [CustomTag.Trace, { traceId: 'B', spanId: 'span' }],
    ])
    await replay.stop()
  })

  it('surfaces window errors and promise rejections as custom events', async () => {
    const { fetchImpl } = recordingFetch()
    const replay = startSessionReplay(baseConfig(fetchImpl))
    const error = new Error('boom')
    error.stack = 'STACK'
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom', filename: 'app.js', error }))
    dispatchRejection('plain')

    expect(handle.addCustomEvent).toHaveBeenCalledWith(CustomTag.Error, {
      message: 'boom',
      source: 'app.js',
      stack: 'STACK',
    })
    expect(handle.addCustomEvent).toHaveBeenCalledWith(CustomTag.Error, { message: 'plain', stack: undefined })
    await replay.stop()
  })

  it('retains the last-known session id when an external callback throws', async () => {
    vi.useFakeTimers()
    let calls = 0
    const onError = vi.fn<() => void>()
    const { fetchImpl } = recordingFetch()
    const replay = startSessionReplay(
      baseConfig(fetchImpl, {
        getSessionId: () => {
          calls += 1
          if (calls > 1) {
            throw new Error('session callback failed')
          }
          return 'stable-session'
        },
        onError,
      })
    )

    expect(replay.getSessionId()).toBe('stable-session')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(replay.getSessionId()).toBe('stable-session')
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'session callback failed' }))
    await replay.stop()
  })

  it('contains throwing trace callbacks and coerces non-string rejection messages', async () => {
    vi.useFakeTimers()
    const onError = vi.fn<() => void>()
    const { fetchImpl } = recordingFetch()
    const replay = startSessionReplay(
      baseConfig(fetchImpl, {
        getTraceContext: () => {
          throw new Error('trace callback failed')
        },
        onError,
      })
    )

    await vi.advanceTimersByTimeAsync(1_000)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'trace callback failed' }))
    dispatchRejection({ message: 42, stack: 'STACK' })
    expect(handle.addCustomEvent).toHaveBeenCalledWith(CustomTag.Error, { message: '42', stack: 'STACK' })
    await replay.stop()
  })
})

describe('startSessionReplay buffer mode', () => {
  it('buffers until an error triggers upload', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const replay = startSessionReplay(baseConfig(fetchImpl, { sessionSampleRate: 0, onErrorSampleRate: 1, random: rng([0.9, 0.1]) }))
    expect(replay.mode).toBe('buffer')
    expect(captured.checkoutEveryNms).toBe(120_000)
    emit(fullSnapshot)
    await replay.flush()
    expect(calls).toHaveLength(0)

    window.dispatchEvent(new ErrorEvent('error', { message: 'boom' }))
    expect(replay.mode).toBe('full')
    await replay.stop()
    expect(calls.map((call) => call.url)).toEqual([`https://app.example.com/replay/${replay.getSessionId()}?seq=0`])
  })

  it('persists full mode after an error promotes a buffered replay', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const replay = startSessionReplay(
      baseConfig(fetchImpl, {
        getSessionId: () => 'buffered-session',
        onErrorSampleRate: 1,
        random: rng([0.9, 0.1]),
        sessionSampleRate: 0,
      })
    )
    expect(replay.mode).toBe('buffer')
    emit(fullSnapshot)

    window.dispatchEvent(new ErrorEvent('error', { message: 'boom' }))
    expect(replay.mode).toBe('full')
    await replay.stop()
    expect(calls).toHaveLength(1)

    const random = vi.fn(() => 0.99)
    const nextReplay = startSessionReplay(
      baseConfig(fetchImpl, {
        getSessionId: () => 'buffered-session',
        onErrorSampleRate: 1,
        random,
        sessionSampleRate: 0,
      })
    )
    expect(nextReplay.mode).toBe('full')
    expect(random).not.toHaveBeenCalled()
    await nextReplay.stop()
  })

  it('does not promote or flush after custom-event handling deactivates the runtime', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const replay = startSessionReplay(
      baseConfig(fetchImpl, {
        onErrorSampleRate: 1,
        random: rng([0.9, 0.1]),
        sessionSampleRate: 0,
      })
    )
    handle.addCustomEvent.mockImplementationOnce(() => {
      replay.stop().catch(() => undefined)
    })

    window.dispatchEvent(new ErrorEvent('error', { message: 'deactivate during error capture' }))
    await replay.stop()

    expect(calls).toHaveLength(0)
  })

  it('does not leak error promotion into a later session sampling decision', async () => {
    vi.useFakeTimers()
    let sessionId = 'promoted-session'
    const { fetchImpl } = recordingFetch()
    const replay = startSessionReplay(
      baseConfig(fetchImpl, {
        getSessionId: () => sessionId,
        onErrorSampleRate: 0.5,
        random: rng([0.9, 0.1, 0.9, 0.9]),
        sessionSampleRate: 0.5,
      })
    )
    expect(replay.mode).toBe('buffer')
    window.dispatchEvent(new ErrorEvent('error', { message: 'promote this session' }))
    expect(replay.mode).toBe('full')

    sessionId = 'sampled-off-session'
    await vi.advanceTimersByTimeAsync(1_000)
    await replay.flush()
    expect(replay.mode).toBe('off')
    expect(replay.recording).toBe(false)
    await replay.stop()
  })
})

describe('startSessionReplay lifecycle', () => {
  it('flushes keepalive on visibility hidden', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const replay = startSessionReplay(baseConfig(fetchImpl))
    emit(fullSnapshot)
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await drainMicrotasks()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.init.keepalive).toBe(true)
    await replay.stop()
  })

  it('flushes keepalive on pagehide while the document is still visible', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const replay = startSessionReplay(baseConfig(fetchImpl))
    emit(fullSnapshot)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    window.dispatchEvent(new PageTransitionEvent('pagehide'))
    await drainMicrotasks()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.init.keepalive).toBe(true)
    await replay.stop()
  })

  it('does not let a throwing onError callback escape from transport reporting', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 })) as unknown as typeof fetch
    const replay = startSessionReplay(
      baseConfig(fetchImpl, {
        onError: () => {
          throw new Error('consumer reporter failed')
        },
      })
    )
    emit(fullSnapshot)
    await expect(replay.flush()).resolves.toBeUndefined()
    await expect(replay.stop()).resolves.toBeUndefined()
  })

  it('does not leak a rejected fire-and-forget pagehide flush when onError throws', async () => {
    const uploadError = new Error('pagehide upload failed')
    const onError = vi.fn(() => {
      throw new Error('consumer reporter failed')
    })
    const unhandledRejection = vi.fn<(reason: unknown) => void>()
    process.on('unhandledRejection', unhandledRejection)
    const fetchImpl = vi.fn(async () => {
      throw uploadError
    }) as unknown as typeof fetch
    const replay = startSessionReplay(baseConfig(fetchImpl, { onError }))
    try {
      emit(fullSnapshot)
      window.dispatchEvent(new PageTransitionEvent('pagehide'))
      await vi.waitFor(() => {
        expect(fetchImpl).toHaveBeenCalledTimes(1)
      })
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })

      expect(onError).toHaveBeenCalledWith(uploadError)
      expect(unhandledRejection).not.toHaveBeenCalled()
      await expect(replay.stop()).resolves.toBeUndefined()
    } finally {
      process.off('unhandledRejection', unhandledRejection)
    }
  })

  it('keeps transition state truthful and prevents pending activation when stop races a delayed old-session flush', async () => {
    let sessionId = 'session-old'
    let resolveFetch: ((response: Response) => void) | undefined
    const calls: string[] = []
    const fetchImpl = vi.fn(
      async (url: string | URL) =>
        new Promise<Response>((resolve) => {
          calls.push(String(url))
          resolveFetch = resolve
        })
    ) as unknown as typeof fetch
    const start = vi.spyOn(recorderMod, 'startRecording')
    const replay = startSessionReplay(baseConfig(fetchImpl, { getSessionId: () => sessionId }))
    emit(fullSnapshot)

    sessionId = 'session-new'
    emit(click)
    expect(replay.mode).toBe('off')
    expect(replay.recording).toBe(false)
    emit(click)

    let flushSettled = false
    const flushPromise = replay.flush().then(() => {
      flushSettled = true
    })
    const stopPromise = replay.stop()
    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    })
    expect(flushSettled).toBe(false)

    resolveFetch?.(new Response(null, { status: 202 }))
    await flushPromise
    await stopPromise

    expect(start).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['https://app.example.com/replay/session-old?seq=0'])
    expect(decodeBody(vi.mocked(fetchImpl).mock.calls[0]![1]?.body).events).toEqual([fullSnapshot])
  })

  it('activates the next session after the old-session final flush fails', async () => {
    let sessionId = 'session-old'
    const onError = vi.fn<(error: unknown) => void>()
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL) => {
      calls.push(String(url))
      return new Response(null, { status: calls.length === 1 ? 400 : 202 })
    }) as unknown as typeof fetch
    const replay = startSessionReplay(baseConfig(fetchImpl, { getSessionId: () => sessionId, onError }))
    emit(fullSnapshot)

    sessionId = 'session-new'
    emit(click)
    await replay.flush()
    expect(replay.recording).toBe(true)
    expect(onError).toHaveBeenCalledTimes(1)

    emit(fullSnapshot)
    await replay.flush()
    await replay.stop()
    expect(calls).toEqual(['https://app.example.com/replay/session-old?seq=0', 'https://app.example.com/replay/session-new?seq=0'])
  })

  it('awaits the final stop flush and makes repeated stop calls idempotent', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const replay = startSessionReplay(baseConfig(fetchImpl))
    emit(fullSnapshot)

    await replay.stop()
    await replay.stop()

    expect(handle.stop).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.init.keepalive).toBe(false)

    const callsAfterStop = calls.length
    window.dispatchEvent(new ErrorEvent('error', { message: 'late' }))
    await drainMicrotasks()
    expect(calls).toHaveLength(callsAfterStop)
  })

  it('honors capture toggles', async () => {
    const { fetchImpl } = recordingFetch()
    const consoleSpy = vi.spyOn(captureMod, 'captureConsole')
    const networkSpy = vi.spyOn(captureMod, 'captureNetwork')
    const navigationSpy = vi.spyOn(captureMod, 'captureNavigation')
    const replay = startSessionReplay(baseConfig(fetchImpl, { captureConsole: false, captureNetwork: false, captureNavigation: false }))

    expect(consoleSpy).not.toHaveBeenCalled()
    expect(networkSpy).not.toHaveBeenCalled()
    expect(navigationSpy).not.toHaveBeenCalled()
    await replay.stop()
  })

  it('applies privacy-safe defaults and preserves selective masking opt-in', async () => {
    const { fetchImpl } = recordingFetch()
    const defaultConfig = baseConfig(fetchImpl)
    delete defaultConfig.captureConsole
    delete defaultConfig.maskAllInputs
    delete defaultConfig.maskAllText
    delete defaultConfig.maskTextSelector
    delete defaultConfig.redactUrlPatterns
    const defaultReplay = startSessionReplay(defaultConfig)

    expect(captured).toMatchObject({
      maskAllInputs: true,
      maskAllText: true,
      maskTextSelector: '',
    })
    expect(captured.redactUrlPatterns).toHaveLength(1)
    expect(captured.redactUrlPatterns[0]?.test('https://app.example.test/?token=secret')).toBe(true)
    await defaultReplay.stop()

    const selectiveReplay = startSessionReplay(
      baseConfig(fetchImpl, {
        maskAllText: false,
        maskTextSelector: '.secret',
        redactUrlPatterns: [],
      })
    )
    expect(captured).toMatchObject({
      maskAllText: false,
      maskTextSelector: '.secret',
      redactUrlPatterns: [],
    })
    await selectiveReplay.stop()
  })

  it('does not install console capture by default', async () => {
    const { fetchImpl } = recordingFetch()
    const consoleSpy = vi.spyOn(captureMod, 'captureConsole')
    const config = baseConfig(fetchImpl)
    delete config.captureConsole
    const replay = startSessionReplay(config)

    expect(consoleSpy).not.toHaveBeenCalled()
    await replay.stop()
  })

  it('wires capture modules to rrweb custom events by default', async () => {
    const { fetchImpl } = recordingFetch()
    const consoleSpy = vi.spyOn(captureMod, 'captureConsole').mockReturnValue(() => {})
    const networkSpy = vi.spyOn(captureMod, 'captureNetwork').mockReturnValue(() => {})
    const navigationSpy = vi.spyOn(captureMod, 'captureNavigation').mockReturnValue(() => {})
    const replay = startSessionReplay(baseConfig(fetchImpl, { captureConsole: true, captureNetwork: true, captureNavigation: true }))

    const consoleEmit = consoleSpy.mock.calls[0]![0]
    const networkEmit = networkSpy.mock.calls[0]![0]
    const navigationEmit = navigationSpy.mock.calls[0]![0]
    consoleEmit('console.tag', { value: 1 })
    networkEmit('network.tag', { value: 2 })
    navigationEmit('navigation.tag', { value: 3 })
    expect(handle.addCustomEvent).toHaveBeenCalledWith('console.tag', { value: 1 })
    expect(handle.addCustomEvent).toHaveBeenCalledWith('network.tag', { value: 2 })
    expect(handle.addCustomEvent).toHaveBeenCalledWith('navigation.tag', { value: 3 })
    await replay.stop()
  })
})

describe('startSessionReplay config validation', () => {
  it('throws on empty replayUrl', () => {
    const { fetchImpl } = recordingFetch()
    expect(() => startSessionReplay(baseConfig(fetchImpl, { replayUrl: '' }))).toThrow(/replayUrl.*required/u)
  })

  it.each(['https://app.example.com/replay?token=x', '/replay#fragment'])(
    'throws when replayUrl contains a query or fragment: %s',
    (replayUrl) => {
      const { fetchImpl } = recordingFetch()
      expect(() => startSessionReplay(baseConfig(fetchImpl, { replayUrl }))).toThrow(/must not contain a query or fragment/u)
    }
  )

  it('retains standalone root replayUrl support', async () => {
    const { fetchImpl } = recordingFetch()
    const replay = startSessionReplay(baseConfig(fetchImpl, { replayUrl: '/' }))
    expect(replay.recording).toBe(true)
    await replay.stop()
  })

  it('throws when fetch is unavailable', () => {
    vi.stubGlobal('fetch', undefined)
    expect(() =>
      startSessionReplay({
        replayUrl: 'https://app.example.com/replay',
        captureConsole: false,
        captureNetwork: false,
        captureNavigation: false,
      })
    ).toThrow(/no `fetch` available/u)
  })
})

function baseConfig(fetchImpl: typeof fetch, overrides: Partial<SessionReplayConfig> = {}): SessionReplayConfig {
  return {
    replayUrl: 'https://app.example.com/replay',
    sessionSampleRate: 1,
    onErrorSampleRate: 1,
    random: () => 0,
    now: () => 1_000,
    fetchImpl,
    captureConsole: false,
    captureNetwork: false,
    captureNavigation: false,
    ...overrides,
  }
}

function recordingFetch() {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return { ok: true, status: 202 } as Response
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

function decodeBody(body: BodyInit | null | undefined): ChunkEnvelope {
  return JSON.parse(strFromU8(gunzipSync(body as Uint8Array))) as ChunkEnvelope
}

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index++) {
    // eslint-disable-next-line no-await-in-loop -- this deliberately drains sequential microtasks.
    await Promise.resolve()
  }
}

function rng(values: number[]): () => number {
  let index = 0
  return () => values[index++] ?? 1
}

function dispatchRejection(reason: unknown): void {
  const event = new Event('unhandledrejection') as Event & { reason: unknown }
  event.reason = reason
  window.dispatchEvent(event)
}
