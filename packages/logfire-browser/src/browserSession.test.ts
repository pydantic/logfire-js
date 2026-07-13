import { describe, expect, it, vi } from 'vite-plus/test'

import { BrowserSessionManager } from './browserSession'

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

class ThrowingStorage extends MemoryStorage {
  override getItem(_key: string): string | null {
    throw new Error('storage unavailable')
  }

  override setItem(_key: string, _value: string): void {
    throw new Error('storage unavailable')
  }
}

class CountingStorage extends MemoryStorage {
  getItemCalls = 0
  setItemCalls = 0

  override getItem(key: string): string | null {
    this.getItemCalls += 1
    return super.getItem(key)
  }

  override setItem(key: string, value: string): void {
    this.setItemCalls += 1
    super.setItem(key, value)
  }
}

function createIdGenerator(): () => string {
  let counter = 0
  return () => {
    counter += 1
    return `session-${counter.toString()}`
  }
}

describe('BrowserSessionManager', () => {
  it('persists session state in storage across manager instances', () => {
    const storage = new MemoryStorage()
    const generateId = createIdGenerator()
    const firstManager = new BrowserSessionManager({
      generateId,
      now: () => 1_000,
      storage,
      storageKey: 'test-session',
    })

    const firstSession = firstManager.touch()
    const secondManager = new BrowserSessionManager({
      generateId,
      now: () => 2_000,
      storage,
      storageKey: 'test-session',
    })

    expect(secondManager.getSession().id).toBe(firstSession.id)
  })

  it('falls back to memory when storage throws', () => {
    const manager = new BrowserSessionManager({
      generateId: createIdGenerator(),
      now: () => 1_000,
      storage: new ThrowingStorage(),
      storageKey: 'test-session',
    })

    const firstSession = manager.touch()
    const secondSession = manager.touch()

    expect(secondSession.id).toBe(firstSession.id)
  })

  it('peeks only at the in-memory session id', () => {
    let now = 1_000
    const storage = new CountingStorage()
    const manager = new BrowserSessionManager({
      generateId: createIdGenerator(),
      idleTimeoutMs: 100,
      maxDurationMs: 1_000,
      now: () => now,
      storage,
      storageKey: 'test-session',
    })

    expect(manager.peekSessionId()).toBeUndefined()
    expect(storage.getItemCalls).toBe(0)
    expect(storage.setItemCalls).toBe(0)

    const session = manager.touch()
    const getItemCallsAfterTouch = storage.getItemCalls
    const setItemCallsAfterTouch = storage.setItemCalls
    now = 1_151

    expect(manager.peekSessionId()).toBe(session.id)
    expect(storage.getItemCalls).toBe(getItemCallsAfterTouch)
    expect(storage.setItemCalls).toBe(setItemCallsAfterTouch)
    expect(manager.getSession().id).not.toBe(session.id)
  })

  it('rotates after the idle timeout', () => {
    let now = 1_000
    const manager = new BrowserSessionManager({
      generateId: createIdGenerator(),
      idleTimeoutMs: 100,
      maxDurationMs: 1_000,
      now: () => now,
      storage: new MemoryStorage(),
      storageKey: 'test-session',
    })

    const firstSession = manager.touch()
    now = 1_050
    expect(manager.touch().id).toBe(firstSession.id)

    now = 1_151
    expect(manager.touch().id).not.toBe(firstSession.id)
  })

  it('rotates after the max duration', () => {
    let now = 1_000
    const manager = new BrowserSessionManager({
      generateId: createIdGenerator(),
      idleTimeoutMs: 1_000,
      maxDurationMs: 100,
      now: () => now,
      storage: new MemoryStorage(),
      storageKey: 'test-session',
    })

    const firstSession = manager.touch()
    now = 1_050
    expect(manager.touch().id).toBe(firstSession.id)

    now = 1_101
    expect(manager.touch().id).not.toBe(firstSession.id)
  })

  it('resets the current session explicitly', () => {
    const manager = new BrowserSessionManager({
      generateId: createIdGenerator(),
      now: () => 1_000,
      storage: new MemoryStorage(),
      storageKey: 'test-session',
    })

    const firstSession = manager.touch()

    expect(manager.reset().id).not.toBe(firstSession.id)
  })

  it('coalesces activity writes and flushes pending storage on cleanup', () => {
    vi.useFakeTimers()
    try {
      let now = 1_000
      const storage = new CountingStorage()
      const manager = new BrowserSessionManager({
        generateId: createIdGenerator(),
        now: () => now,
        storage,
        storageKey: 'test-session',
      })

      const first = manager.touch()
      const initialWrites = storage.setItemCalls
      now = 1_050
      manager.touch()
      now = 1_100
      manager.touch()
      expect(storage.setItemCalls).toBe(initialWrites)
      expect(manager.getSession().id).toBe(first.id)

      vi.advanceTimersByTime(999)
      expect(storage.setItemCalls).toBe(initialWrites)
      manager.flushPendingStorage()
      expect(storage.setItemCalls).toBe(initialWrites + 1)
      const stored = JSON.parse(storage.getItem('test-session') ?? '') as { lastActivityAt: number }
      expect(stored.lastActivityAt).toBe(1_100)
    } finally {
      vi.useRealTimers()
    }
  })
})
