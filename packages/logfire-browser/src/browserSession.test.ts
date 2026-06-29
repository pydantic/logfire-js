import { describe, expect, it } from 'vite-plus/test'

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
})
