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

  it('snapshots, bounds, and persists session attributes once per session', () => {
    const storage = new MemoryStorage()
    const getSessionAttributes = vi.fn<() => Record<string, string | number | boolean | undefined>>(() => ({
      account_tier: 'pro',
      beta_user: true,
      seats: 12,
      invalid: Number.NaN,
    }))
    const firstManager = new BrowserSessionManager({
      generateId: createIdGenerator(),
      getSessionAttributes,
      now: () => 1_000,
      storage,
      storageKey: 'test-session',
    })

    expect(firstManager.touch().sessionAttributes).toEqual({
      account_tier: 'pro',
      beta_user: true,
      seats: 12,
    })
    expect(firstManager.touch().sessionAttributes).toEqual({
      account_tier: 'pro',
      beta_user: true,
      seats: 12,
    })
    expect(getSessionAttributes).toHaveBeenCalledTimes(1)

    const secondCallback = vi.fn<() => Record<string, string>>(() => ({ account_tier: 'free' }))
    const secondManager = new BrowserSessionManager({
      generateId: createIdGenerator(),
      getSessionAttributes: secondCallback,
      now: () => 2_000,
      storage,
      storageKey: 'test-session',
    })
    expect(secondManager.touch().sessionAttributes).toEqual({
      account_tier: 'pro',
      beta_user: true,
      seats: 12,
    })
    expect(secondCallback).not.toHaveBeenCalled()
  })

  it('hydrates legacy stored sessions without changing their id', () => {
    const storage = new MemoryStorage()
    storage.setItem(
      'test-session',
      JSON.stringify({
        id: 'legacy-session',
        lastActivityAt: 1_000,
        startedAt: 1_000,
      })
    )
    const getSessionAttributes = vi.fn<() => Record<string, string>>(() => ({ account_tier: 'pro' }))
    const manager = new BrowserSessionManager({
      generateId: createIdGenerator(),
      getSessionAttributes,
      now: () => 1_100,
      storage,
      storageKey: 'test-session',
    })

    expect(manager.touch()).toMatchObject({
      id: 'legacy-session',
      sessionAttributes: { account_tier: 'pro' },
    })
    expect(getSessionAttributes).toHaveBeenCalledTimes(1)
    expect(JSON.parse(storage.getItem('test-session') ?? '')).toMatchObject({
      id: 'legacy-session',
      sessionAttributes: { account_tier: 'pro' },
    })
  })

  it('captures a fresh snapshot when the session rotates', () => {
    let now = 1_000
    let tier = 'pro'
    const manager = new BrowserSessionManager({
      generateId: createIdGenerator(),
      getSessionAttributes: () => ({ tier }),
      idleTimeoutMs: 100,
      maxDurationMs: 1_000,
      now: () => now,
      storage: new MemoryStorage(),
      storageKey: 'test-session',
    })

    expect(manager.touch().sessionAttributes).toEqual({ tier: 'pro' })
    tier = 'enterprise'
    expect(manager.touch().sessionAttributes).toEqual({ tier: 'pro' })
    now = 1_101
    expect(manager.touch().sessionAttributes).toEqual({ tier: 'enterprise' })
  })

  it('silently contains hostile session and route callbacks', () => {
    const sessionCallback = vi.fn<() => Record<string, string>>(() => {
      throw new Error('session dimensions unavailable')
    })
    const routeCallback = vi.fn<() => string>(() => {
      throw new Error('router unavailable')
    })
    const manager = new BrowserSessionManager({
      generateId: createIdGenerator(),
      getRouteName: routeCallback,
      getSessionAttributes: sessionCallback,
      now: () => 1_000,
      storage: new MemoryStorage(),
      storageKey: 'test-session',
    })

    expect(manager.touch().sessionAttributes).toEqual({})
    expect(manager.getRouteName()).toBeUndefined()
    expect(sessionCallback).toHaveBeenCalledTimes(1)
    expect(routeCallback).toHaveBeenCalledTimes(1)
  })

  it('enforces the complete session attribute boundary without mutating input', () => {
    const source: Record<string, unknown> = {
      Invalid: 'uppercase',
      invalid_infinity: Number.POSITIVE_INFINITY,
      invalid_nan: Number.NaN,
      invalid_object: {},
      invalid_string: '🚀'.repeat(201),
      skipped: undefined,
      valid_unicode: '🚀'.repeat(200),
    }
    for (let index = 0; index < 25; index++) {
      source[`valid_${index.toString()}`] = index
    }
    source['invalid-key'] = 'dash'
    source[`a${'b'.repeat(64)}`] = 'too long'
    const manager = new BrowserSessionManager({
      generateId: createIdGenerator(),
      getSessionAttributes: () => source as Record<string, string | number | boolean | undefined>,
      now: () => 1_000,
      storage: new MemoryStorage(),
      storageKey: 'test-session',
    })

    const attributes = manager.touch().sessionAttributes
    source['valid_unicode'] = 'changed'

    expect(attributes?.['valid_unicode']).toBe('🚀'.repeat(200))
    expect(Object.keys(attributes ?? {})).toHaveLength(20)
    expect(attributes?.['valid_18']).toBe(18)
    expect(attributes?.['valid_19']).toBeUndefined()
    expect(attributes?.['Invalid']).toBeUndefined()
    expect(Object.isFrozen(attributes)).toBe(true)
  })

  it('accepts plain and null-prototype records while containing hostile containers and properties', () => {
    const inherited = Object.create({ inherited: 'ignored' }) as Record<string, string>
    inherited['own'] = 'also rejected with its custom prototype'
    const nullPrototype = Object.assign(Object.create(null) as Record<string, string>, { tier: 'pro' })
    const frozen = Object.freeze({ tier: 'frozen' })
    const sealed = Object.seal({ tier: 'sealed' })
    const throwingProperty = Object.defineProperty({ healthy: true }, 'broken', {
      enumerable: true,
      get: () => {
        throw new Error('property unavailable')
      },
    })
    class Dimensions {
      tier = 'pro'
    }
    const prototypeProxy = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('prototype unavailable')
        },
      }
    )
    const enumerationProxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('enumeration unavailable')
        },
      }
    )
    const values: unknown[] = [
      nullPrototype,
      frozen,
      sealed,
      throwingProperty,
      inherited,
      [],
      () => ({}),
      new Date(),
      new Dimensions(),
      prototypeProxy,
      enumerationProxy,
    ]
    const expected = [{ tier: 'pro' }, { tier: 'frozen' }, { tier: 'sealed' }, { healthy: true }, {}, {}, {}, {}, {}, {}, {}]

    expect(
      values.map((value) => {
        const manager = new BrowserSessionManager({
          generateId: createIdGenerator(),
          getSessionAttributes: () => value as Record<string, string | number | boolean | undefined>,
          now: () => 1_000,
          storage: new MemoryStorage(),
          storageKey: 'test-session',
        })
        return manager.touch().sessionAttributes
      })
    ).toEqual(expected)
  })

  it('revalidates tampered persisted attributes', () => {
    const storage = new MemoryStorage()
    storage.setItem(
      'test-session',
      JSON.stringify({
        id: 'stored-session',
        lastActivityAt: 1_000,
        sessionAttributes: {
          account_tier: 'pro',
          nested: { secret: true },
          seats: Number.POSITIVE_INFINITY,
        },
        startedAt: 1_000,
      })
    )
    const manager = new BrowserSessionManager({
      generateId: createIdGenerator(),
      now: () => 1_100,
      storage,
      storageKey: 'test-session',
    })

    expect(manager.touch().sessionAttributes).toEqual({ account_tier: 'pro' })
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
