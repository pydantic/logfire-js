/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FakeLockManager } from './fakeLockManager.testing'
import { claimRecordingLock, recordingLockManager } from './recordingLock'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const LOCK_NAME = 'logfire-session-replay:recording-a'

describe('claimRecordingLock', () => {
  it('holds a free lock until it is released', async () => {
    const locks = new FakeLockManager()

    const claim = await claimRecordingLock(locks as unknown as LockManager, 'recording-a', new AbortController().signal)

    expect(claim.kind).toBe('held')
    expect(locks.requested).toEqual([LOCK_NAME])
    expect(locks.isHeld(LOCK_NAME)).toBe(true)
    if (claim.kind === 'held') {
      claim.lock.release()
    }
    await vi.waitFor(() => {
      expect(locks.isHeld(LOCK_NAME)).toBe(false)
    })
  })

  it('times out while another document holds the lock, and keeps the lifecycle signal unaborted', async () => {
    vi.useFakeTimers()
    const locks = new FakeLockManager()
    const holder = await claimRecordingLock(locks as unknown as LockManager, 'recording-a', new AbortController().signal)
    expect(holder.kind).toBe('held')
    const lifecycle = new AbortController()

    const pending = claimRecordingLock(locks as unknown as LockManager, 'recording-a', lifecycle.signal, 1_000)
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(pending).resolves.toEqual({ kind: 'timeout' })
    expect(lifecycle.signal.aborted).toBe(false)
    expect(locks.isHeld(LOCK_NAME)).toBe(true)
  })

  it('waits for a lock that the previous document releases within the bound', async () => {
    vi.useFakeTimers()
    const locks = new FakeLockManager()
    const previous = await claimRecordingLock(locks as unknown as LockManager, 'recording-a', new AbortController().signal)

    const pending = claimRecordingLock(locks as unknown as LockManager, 'recording-a', new AbortController().signal, 1_000)
    await vi.advanceTimersByTimeAsync(300)
    if (previous.kind === 'held') {
      previous.lock.release()
    }
    await vi.advanceTimersByTimeAsync(0)

    await expect(pending).resolves.toMatchObject({ kind: 'held' })
  })

  it('ends the wait when the lifecycle aborts, and never grants the aborted request later', async () => {
    vi.useFakeTimers()
    const locks = new FakeLockManager()
    const previous = await claimRecordingLock(locks as unknown as LockManager, 'recording-a', new AbortController().signal)
    const lifecycle = new AbortController()

    const pending = claimRecordingLock(locks as unknown as LockManager, 'recording-a', lifecycle.signal, 1_000)
    lifecycle.abort()

    await expect(pending).resolves.toEqual({ kind: 'aborted' })
    if (previous.kind === 'held') {
      previous.lock.release()
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(locks.isHeld(LOCK_NAME)).toBe(false)
  })

  it('returns aborted without requesting when the lifecycle already ended', async () => {
    const locks = new FakeLockManager()
    const lifecycle = new AbortController()
    lifecycle.abort()

    await expect(claimRecordingLock(locks as unknown as LockManager, 'recording-a', lifecycle.signal)).resolves.toEqual({ kind: 'aborted' })
    expect(locks.requested).toEqual([])
  })

  it('releases a grant at once when the lifecycle ended while the grant was being delivered', async () => {
    const lifecycle = new AbortController()
    const locks = {
      request: async (_name: string, _options: LockOptions, callback: (lock: Lock | null) => unknown) => {
        lifecycle.abort()
        return Promise.resolve(callback({ mode: 'exclusive', name: LOCK_NAME }))
      },
    }

    await expect(claimRecordingLock(locks as unknown as LockManager, 'recording-a', lifecycle.signal)).resolves.toEqual({ kind: 'aborted' })
  })

  it('treats a held lock that the browser drops as released, without reporting an error', async () => {
    const locks = new FakeLockManager()
    const claim = await claimRecordingLock(locks as unknown as LockManager, 'recording-a', new AbortController().signal)
    expect(claim.kind).toBe('held')

    locks.drop(LOCK_NAME)

    const next = await claimRecordingLock(locks as unknown as LockManager, 'recording-a', new AbortController().signal)
    expect(next.kind).toBe('held')
  })

  it('returns aborted when the lock manager throws', async () => {
    const locks = {
      request: () => {
        throw new TypeError('invalid lock name')
      },
    }

    await expect(claimRecordingLock(locks as unknown as LockManager, 'recording-a', new AbortController().signal)).resolves.toEqual({
      kind: 'aborted',
    })
  })
})

describe('recordingLockManager', () => {
  it('returns the Web Locks manager in a secure context', () => {
    const locks = new FakeLockManager()
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('navigator', { locks })

    expect(recordingLockManager()).toBe(locks)
  })

  it('returns undefined outside a secure context', () => {
    vi.stubGlobal('isSecureContext', false)
    vi.stubGlobal('navigator', { locks: new FakeLockManager() })

    expect(recordingLockManager()).toBeUndefined()
  })

  it('returns undefined when the browser has no Web Locks', () => {
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('navigator', { locks: undefined })

    expect(recordingLockManager()).toBeUndefined()
  })
})
