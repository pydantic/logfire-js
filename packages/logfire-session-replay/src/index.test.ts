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
  vi.spyOn(recorderMod, 'startRecording').mockImplementation((options) => {
    captured = options
    handle = {
      stop: vi.fn<() => void>(),
      addCustomEvent: vi.fn<(tag: string, payload: unknown) => void>(),
      takeFullSnapshot: vi.fn<() => void>(),
    }
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
    expect(replay.getSessionId()).toBe('')
    expect(start).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it("is a no-op when sampling resolves to 'off'", () => {
    const { fetchImpl } = recordingFetch()
    const start = vi.spyOn(recorderMod, 'startRecording')
    const replay = startSessionReplay(baseConfig(fetchImpl, { sessionSampleRate: 0, onErrorSampleRate: 0, random: () => 0.99 }))
    expect(replay.recording).toBe(false)
    expect(start).not.toHaveBeenCalled()
  })
})

describe('startSessionReplay full mode', () => {
  it('flushes a chunk through the proxy URL and returns an internal session id', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const replay = startSessionReplay(baseConfig(fetchImpl))
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

  it('uses external getSessionId and rotates transport when it changes', async () => {
    let sessionId = 'external-1'
    const { calls, fetchImpl } = recordingFetch()
    const replay = startSessionReplay(baseConfig(fetchImpl, { getSessionId: () => sessionId }))
    expect(replay.getSessionId()).toBe('external-1')
    emit(fullSnapshot)

    sessionId = 'external-2'
    emit(click)
    expect(handle.takeFullSnapshot).toHaveBeenCalledTimes(1)
    await replay.flush()
    await settle()

    expect(calls.map((call) => call.url)).toEqual([
      'https://app.example.com/replay/external-1?seq=0',
      'https://app.example.com/replay/external-2?seq=0',
    ])
    await replay.stop()
  })

  it('starts interval flushing in full mode', async () => {
    vi.useFakeTimers()
    const { fetchImpl } = recordingFetch()
    const setSpy = vi.spyOn(globalThis, 'setInterval')
    const replay = startSessionReplay(baseConfig(fetchImpl))
    expect(setSpy.mock.calls.map((call) => call[1])).toContain(5_000)
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
})

describe('startSessionReplay buffer mode', () => {
  it('buffers until an error triggers upload', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const replay = startSessionReplay(baseConfig(fetchImpl, { sessionSampleRate: 0, onErrorSampleRate: 1, random: rng([0.9, 0.1]) }))
    expect(captured.checkoutEveryNms).toBe(120_000)
    emit(fullSnapshot)
    await replay.flush()
    expect(calls).toHaveLength(0)

    window.dispatchEvent(new ErrorEvent('error', { message: 'boom' }))
    await settle()
    expect(calls.map((call) => call.url)).toEqual([`https://app.example.com/replay/${replay.getSessionId()}?seq=0`])
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

  it('awaits the final stop flush and makes repeated stop calls idempotent', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const replay = startSessionReplay(baseConfig(fetchImpl))
    emit(fullSnapshot)

    await replay.stop()
    await replay.stop()

    expect(handle.stop).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.init.keepalive).toBe(true)

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

async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 50)
  })
  await Promise.resolve()
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
