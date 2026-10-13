/**
 * @vitest-environment jsdom
 */
/* eslint-disable @typescript-eslint/require-await, vitest/require-mock-type-parameters */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import { FakeLockManager } from './fakeLockManager.testing'
import { startSessionReplay } from './index'
import * as recorderMod from './recorder'
import { RECORDING_OWNER_STORAGE_KEY, RECORDING_STORAGE_KEY } from './recordingIdentity'
import { claimRecordingLock } from './recordingLock'
import { SEQ_STORAGE_KEY } from './transport'
import { CustomTag, EventType, IncrementalSource, MouseInteractions } from './types'
import type { RrwebEvent, SessionReplayConfig } from './types'

let captured: recorderMod.RecorderOptions
let handle: { stop: Mock<() => void>; addCustomEvent: Mock<(tag: string, payload: unknown) => void>; takeFullSnapshot: Mock<() => void> }
let locks: FakeLockManager
let started: { stop(): Promise<void> }[] = []

const fullSnapshot: RrwebEvent = { type: EventType.FullSnapshot, data: { node: {} }, timestamp: 1 }
const click: RrwebEvent = {
  type: EventType.IncrementalSnapshot,
  data: { source: IncrementalSource.MouseInteraction, type: MouseInteractions.Click },
  timestamp: 2,
}
const SESSION_ID = 'rum-session'

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  locks = new FakeLockManager()
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('navigator', { locks })
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

afterEach(async () => {
  // A failed assertion must not leave the page's controller lease to the next test.
  await Promise.all(started.map(async (replay) => replay.stop()))
  started = []
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('coordinated replay recording', () => {
  it('records nothing before the lock is granted, then starts at sequence 0 of a new recording', async () => {
    const gate = deferred()
    vi.stubGlobal('navigator', { locks: gatedLocks(locks, gate.promise) })
    const { calls, fetchImpl } = recordingFetch()
    const replay = start(config(fetchImpl))

    await drainMicrotasks()
    expect(recorderMod.startRecording).not.toHaveBeenCalled()
    expect(replay.recording).toBe(false)
    expect(replay.mode).toBe('off')
    expect(replay.getRecordingId()).toBe('')

    gate.resolve()
    await vi.waitFor(() => {
      expect(replay.recording).toBe(true)
    })
    const recordingId = replay.getRecordingId()
    expect(locks.isHeld(lockName(recordingId))).toBe(true)
    captured.emit(fullSnapshot)
    await replay.flush()

    expect(calls.map((call) => call.url)).toEqual([`https://app.example.com/replay/${recordingId}?seq=0`])
    expect(localStorage.getItem(`lf_session_replay_seq:${recordingId}`)).toBe(JSON.stringify({ seq: 1, at: 1_000 }))
    await replay.stop()
  })

  it('adds errors captured while the lock is pending, with the time they occurred', async () => {
    const gate = deferred()
    vi.stubGlobal('navigator', { locks: gatedLocks(locks, gate.promise) })
    const { fetchImpl } = recordingFetch()
    const replay = start(config(fetchImpl))

    replay.captureError(new Error('early failure'), { timestamp: 500 })
    gate.resolve()
    await vi.waitFor(() => {
      expect(replay.recording).toBe(true)
    })

    expect(handle.addCustomEvent).toHaveBeenCalledWith(
      CustomTag.Error,
      expect.objectContaining({ message: 'early failure', timestamp: 500 })
    )
    await replay.stop()
  })

  it('starts a new recording when another document holds the resumed recording', async () => {
    vi.useFakeTimers()
    seedResumableRecording('recording-r', 4, 9)
    const other = await claimRecordingLock(locks as unknown as LockManager, 'recording-r', new AbortController().signal)
    expect(other.kind).toBe('held')
    const { calls, fetchImpl } = recordingFetch()
    const replay = start(config(fetchImpl))

    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => {
      expect(replay.recording).toBe(true)
    })
    const recordingId = replay.getRecordingId()
    captured.emit(fullSnapshot)
    await replay.flush()

    expect(recordingId).not.toBe('recording-r')
    expect(calls.map((call) => call.url)).toEqual([`https://app.example.com/replay/${recordingId}?seq=0`])
    expect(locks.isHeld(lockName('recording-r'))).toBe(true)
    await replay.stop()
  })

  it('continues a released recording from the shared sequence, not the copied one', async () => {
    seedResumableRecording('recording-r', 4, 9)
    const { calls, fetchImpl } = recordingFetch()
    const replay = start(config(fetchImpl))

    await vi.waitFor(() => {
      expect(replay.recording).toBe(true)
    })
    captured.emit(fullSnapshot)
    await replay.flush()

    expect(replay.getRecordingId()).toBe('recording-r')
    expect(calls.map((call) => call.url)).toEqual(['https://app.example.com/replay/recording-r?seq=9'])
    await replay.stop()
  })

  it('starts a new recording when a resumed recording has no shared sequence record', async () => {
    seedResumableRecording('recording-r', 4, undefined)
    const { calls, fetchImpl } = recordingFetch()
    const replay = start(config(fetchImpl))

    await vi.waitFor(() => {
      expect(replay.recording).toBe(true)
    })
    const recordingId = replay.getRecordingId()
    captured.emit(fullSnapshot)
    await replay.flush()

    expect(recordingId).not.toBe('recording-r')
    expect(calls.map((call) => call.url)).toEqual([`https://app.example.com/replay/${recordingId}?seq=0`])
    expect(locks.isHeld(lockName('recording-r'))).toBe(false)
    await replay.stop()
  })

  it('releases the lock at pagehide after reserving the final sequence, and claims it again at pageshow', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const replay = start(config(fetchImpl))
    await vi.waitFor(() => {
      expect(replay.recording).toBe(true)
    })
    const recordingId = replay.getRecordingId()
    captured.emit(fullSnapshot)
    captured.emit(click)

    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
    await drainMicrotasks()

    expect(locks.isHeld(lockName(recordingId))).toBe(false)
    expect(calls.map((call) => call.url)).toEqual([`https://app.example.com/replay/${recordingId}?seq=0`])
    expect(localStorage.getItem(`lf_session_replay_seq:${recordingId}`)).toBe(JSON.stringify({ seq: 1, at: 1_000 }))

    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    await vi.waitFor(() => {
      expect(replay.recording).toBe(true)
    })
    expect(replay.getRecordingId()).toBe(recordingId)
    expect(locks.isHeld(lockName(recordingId))).toBe(true)
    captured.emit(fullSnapshot)
    await replay.flush()
    expect(calls.map((call) => call.url).at(-1)).toBe(`https://app.example.com/replay/${recordingId}?seq=1`)
    await replay.stop()
  })

  it('starts a new recording at pageshow when another document took the recording while the page was hidden', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const replay = start(config(fetchImpl))
    await vi.waitFor(() => {
      expect(replay.recording).toBe(true)
    })
    const recordingId = replay.getRecordingId()
    captured.emit(fullSnapshot)
    await replay.flush()
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
    await drainMicrotasks()
    vi.useFakeTimers()
    const other = await claimRecordingLock(locks as unknown as LockManager, recordingId, new AbortController().signal)
    expect(other.kind).toBe('held')

    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    await vi.advanceTimersByTimeAsync(1_100)
    vi.useRealTimers()
    await vi.waitFor(() => {
      expect(replay.recording).toBe(true)
    })
    const restoredRecordingId = replay.getRecordingId()
    captured.emit(fullSnapshot)
    await replay.flush()

    expect(restoredRecordingId).not.toBe(recordingId)
    expect(calls.map((call) => call.url)).toEqual([
      `https://app.example.com/replay/${recordingId}?seq=0`,
      `https://app.example.com/replay/${restoredRecordingId}?seq=0`,
    ])
    if (other.kind === 'held') {
      other.lock.release()
    }
  })

  it('releases the old recording and holds the new one when the RUM session rotates', async () => {
    let sessionId = SESSION_ID
    const { calls, fetchImpl } = recordingFetch()
    const replay = start(config(fetchImpl, { getSessionId: () => sessionId }))
    await vi.waitFor(() => {
      expect(replay.recording).toBe(true)
    })
    const firstRecordingId = replay.getRecordingId()
    captured.emit(fullSnapshot)
    await replay.flush()

    sessionId = 'rotated-session'
    captured.emit(click)
    await vi.waitFor(() => {
      expect(replay.recording).toBe(true)
      expect(replay.getRecordingId()).not.toBe('')
    })
    await drainMicrotasks()
    const secondRecordingId = replay.getRecordingId()

    expect(secondRecordingId).not.toBe(firstRecordingId)
    expect(locks.isHeld(lockName(firstRecordingId))).toBe(false)
    expect(locks.isHeld(lockName(secondRecordingId))).toBe(true)
    expect(calls.map((call) => call.url)).toEqual([`https://app.example.com/replay/${firstRecordingId}?seq=0`])
  })

  it('aborts a pending lock request when replay stops, and activates nothing on a late grant', async () => {
    const gate = deferred()
    vi.stubGlobal('navigator', { locks: gatedLocks(locks, gate.promise) })
    const { fetchImpl } = recordingFetch()
    const replay = start(config(fetchImpl))
    await drainMicrotasks()

    await replay.stop()
    gate.resolve()
    await drainMicrotasks()

    expect(recorderMod.startRecording).not.toHaveBeenCalled()
    expect(locks.requested.every((name) => !locks.isHeld(name))).toBe(true)
    const next = start(config(fetchImpl))
    await next.stop()
  })

  it('aborts a pending lock request at pagehide', async () => {
    const gate = deferred()
    vi.stubGlobal('navigator', { locks: gatedLocks(locks, gate.promise) })
    const { fetchImpl } = recordingFetch()
    const replay = start(config(fetchImpl))
    await drainMicrotasks()

    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
    gate.resolve()
    await drainMicrotasks()

    expect(recorderMod.startRecording).not.toHaveBeenCalled()
    expect(locks.requested.every((name) => !locks.isHeld(name))).toBe(true)
    await replay.stop()
  })

  it('moves to a new recording when the shared record cannot confirm a sequence', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const replay = start(config(fetchImpl))
    await vi.waitFor(() => {
      expect(replay.recording).toBe(true)
    })
    const firstRecordingId = replay.getRecordingId()
    captured.emit(fullSnapshot)
    await replay.flush()
    const originalSetItem = Object.getOwnPropertyDescriptor(Storage.prototype, 'setItem')?.value as (
      this: Storage,
      key: string,
      value: string
    ) => void
    const failing = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === `lf_session_replay_seq:${firstRecordingId}`) {
        throw new DOMException('quota exceeded', 'QuotaExceededError')
      }
      Reflect.apply(originalSetItem, this, [key, value])
    })

    captured.emit(click)
    await replay.flush()
    await vi.waitFor(() => {
      expect(replay.getRecordingId()).not.toBe(firstRecordingId)
      expect(replay.recording).toBe(true)
    })
    failing.mockRestore()
    const secondRecordingId = replay.getRecordingId()
    captured.emit(fullSnapshot)
    await replay.flush()

    expect(calls.map((call) => call.url)).toEqual([
      `https://app.example.com/replay/${firstRecordingId}?seq=0`,
      `https://app.example.com/replay/${secondRecordingId}?seq=0`,
    ])
    expect(locks.isHeld(lockName(firstRecordingId))).toBe(false)
    expect(locks.isHeld(lockName(secondRecordingId))).toBe(true)
    await replay.stop()
  })

  it('releases the lock when replay stops', async () => {
    const { fetchImpl } = recordingFetch()
    const replay = start(config(fetchImpl))
    await vi.waitFor(() => {
      expect(replay.recording).toBe(true)
    })
    const recordingId = replay.getRecordingId()

    await replay.stop()
    await drainMicrotasks()

    expect(locks.isHeld(lockName(recordingId))).toBe(false)
  })

  it('requests no lock for a session that sampling leaves unrecorded', async () => {
    const { fetchImpl } = recordingFetch()
    const replay = start(config(fetchImpl, { sessionSampleRate: 0, onErrorSampleRate: 0, random: () => 0.99 }))
    await drainMicrotasks()

    expect(locks.requested).toEqual([])
    expect(replay.mode).toBe('off')
    await replay.stop()
  })
})

describe('uncoordinated replay recording', () => {
  it.each([
    ['an insecure context', () => vi.stubGlobal('isSecureContext', false)],
    ['a browser without Web Locks', () => vi.stubGlobal('navigator', {})],
    [
      'unwritable localStorage',
      () =>
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string) {
          if (this === localStorage) {
            throw new DOMException(`denied ${key}`, 'SecurityError')
          }
        }),
    ],
  ])('starts recording synchronously in %s', async (_label, disable) => {
    disable()
    const { fetchImpl } = recordingFetch()

    const replay = start(config(fetchImpl))

    expect(replay.recording).toBe(true)
    expect(locks.requested).toEqual([])
    await replay.stop()
  })
})

function start(replayConfig: SessionReplayConfig): ReturnType<typeof startSessionReplay> {
  const replay = startSessionReplay(replayConfig)
  started.push(replay)
  return replay
}

function config(fetchImpl: typeof fetch, overrides: Partial<SessionReplayConfig> = {}): SessionReplayConfig {
  return {
    replayUrl: 'https://app.example.com/replay',
    sessionSampleRate: 1,
    onErrorSampleRate: 1,
    random: () => 0,
    now: () => 1_000,
    minSessionDurationMs: 0,
    getSessionId: () => SESSION_ID,
    fetchImpl,
    captureConsole: false,
    captureNetwork: false,
    captureNavigation: false,
    ...overrides,
  }
}

function recordingFetch() {
  const calls: { url: string }[] = []
  const fetchImpl = vi.fn(async (url: string | URL) => {
    calls.push({ url: String(url) })
    return { ok: true, status: 202 } as Response
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

/** Make the earlier document of this tab look released, with a copied sequence and an optional shared record. */
function seedResumableRecording(recordingId: string, copiedSeq: number, sharedSeq: number | undefined): void {
  sessionStorage.removeItem(RECORDING_OWNER_STORAGE_KEY)
  sessionStorage.setItem(RECORDING_STORAGE_KEY, JSON.stringify({ id: recordingId, rumSessionId: SESSION_ID, startedAt: 900 }))
  sessionStorage.setItem(SEQ_STORAGE_KEY, JSON.stringify({ id: recordingId, seq: copiedSeq }))
  if (sharedSeq !== undefined) {
    localStorage.setItem(`lf_session_replay_seq:${recordingId}`, JSON.stringify({ seq: sharedSeq, at: 900 }))
  }
}

function lockName(recordingId: string): string {
  return `logfire-session-replay:${recordingId}`
}

/** Delay every lock request until `gate` resolves. */
function gatedLocks(inner: FakeLockManager, gate: Promise<void>) {
  return {
    request: async (name: string, options: LockOptions, callback: (lock: Lock | null) => unknown) => {
      inner.requested.push(`gated:${name}`)
      await gate
      return inner.request(name, options, callback)
    },
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index++) {
    // eslint-disable-next-line no-await-in-loop -- this deliberately drains sequential microtasks.
    await Promise.resolve()
  }
}
