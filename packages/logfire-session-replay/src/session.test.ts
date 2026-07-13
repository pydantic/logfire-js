import { describe, expect, it, vi } from 'vitest'

import { SESSION_STORAGE_KEY, SessionManager } from './session'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

class ThrowingStorage extends MemoryStorage {
  override getItem(_key: string): string | null {
    throw new Error('storage unavailable')
  }

  override setItem(_key: string, _value: string): void {
    throw new Error('storage unavailable')
  }
}

function manager(now: () => number, options: { idleTimeoutMs: number; maxDurationMs: number }) {
  return new SessionManager({ ...options, now, storage: new MemoryStorage() })
}

describe('SessionManager', () => {
  it('reuses the session while the user stays active', () => {
    let now = 1_000
    const sessions = manager(() => now, { idleTimeoutMs: 100, maxDurationMs: 10_000 })
    const first = sessions.getSession()
    now = 1_050
    sessions.touch()
    now = 1_100
    expect(sessions.getSession().id).toBe(first.id)
  })

  it('rotates after the idle timeout', () => {
    let now = 1_000
    const sessions = manager(() => now, { idleTimeoutMs: 100, maxDurationMs: 10_000 })
    const first = sessions.getSession()
    now = 1_200
    expect(sessions.getSession().id).not.toBe(first.id)
  })

  it('rotates after max duration even with activity', () => {
    let now = 1_000
    const sessions = manager(() => now, { idleTimeoutMs: 100_000, maxDurationMs: 500 })
    const first = sessions.getSession()
    now = 1_400
    sessions.touch()
    now = 1_600
    expect(sessions.getSession().id).not.toBe(first.id)
  })

  it('persists lastActivityAt to storage on touch', () => {
    let now = 1_000
    const storage = new MemoryStorage()
    const sessions = new SessionManager({ idleTimeoutMs: 100_000, maxDurationMs: 100_000, now: () => now, storage })
    sessions.getSession()
    now = 1_500
    sessions.touch()
    sessions.flushPendingStorage()
    const storedSession = storage.getItem(SESSION_STORAGE_KEY)
    expect(storedSession).not.toBeNull()
    const stored = JSON.parse(storedSession ?? '') as { lastActivityAt: number }
    expect(stored.lastActivityAt).toBe(1_500)
  })

  it('coalesces activity writes while keeping in-memory expiry current', () => {
    vi.useFakeTimers()
    try {
      let now = 1_000
      const storage = new MemoryStorage()
      const sessions = new SessionManager({ idleTimeoutMs: 100, maxDurationMs: 10_000, now: () => now, storage })
      const first = sessions.getSession()

      now = 1_050
      sessions.touch()
      now = 1_100
      sessions.touch()
      const initialStored = JSON.parse(storage.getItem(SESSION_STORAGE_KEY) ?? '') as { lastActivityAt: number }
      expect(initialStored.lastActivityAt).toBe(1_000)
      expect(sessions.getSession().id).toBe(first.id)

      vi.advanceTimersByTime(999)
      const beforeFlush = JSON.parse(storage.getItem(SESSION_STORAGE_KEY) ?? '') as { lastActivityAt: number }
      expect(beforeFlush.lastActivityAt).toBe(1_000)
      vi.advanceTimersByTime(1)
      const afterFlush = JSON.parse(storage.getItem(SESSION_STORAGE_KEY) ?? '') as { lastActivityAt: number }
      expect(afterFlush.lastActivityAt).toBe(1_100)

      now = 1_201
      expect(sessions.getSession().id).not.toBe(first.id)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects malformed stored sessions', () => {
    const storage = new MemoryStorage()
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ id: 'stale-id', lastActivityAt: 1_000 }))
    const sessions = new SessionManager({ idleTimeoutMs: 100_000, maxDurationMs: 100_000, now: () => 1_000, storage })
    expect(sessions.getSession().id).not.toBe('stale-id')
  })

  it('keeps session identity working when storage throws', () => {
    let now = 1_000
    const sessions = new SessionManager({
      idleTimeoutMs: 100_000,
      maxDurationMs: 100_000,
      now: () => now,
      storage: new ThrowingStorage(),
    })
    const first = sessions.touch()
    now = 1_500
    expect(sessions.touch().id).toBe(first.id)
  })
})
