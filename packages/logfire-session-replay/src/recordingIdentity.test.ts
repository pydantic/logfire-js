import { describe, expect, it } from 'vitest'

import { MAX_RECORDING_DURATION_MS, RECORDING_OWNER_STORAGE_KEY, RECORDING_STORAGE_KEY, RecordingIdentity } from './recordingIdentity'
import { SEQ_STORAGE_KEY } from './transport'

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
    return [...this.items.keys()][index] ?? null
  }
  removeItem(key: string): void {
    this.items.delete(key)
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value)
  }
}

function resumableStorage(): MemoryStorage {
  const storage = new MemoryStorage()
  storage.setItem(RECORDING_STORAGE_KEY, JSON.stringify({ id: 'tab-replay', rumSessionId: 'rum-session', startedAt: 1_000 }))
  storage.setItem(SEQ_STORAGE_KEY, JSON.stringify({ id: 'tab-replay', seq: 7 }))
  return storage
}

describe('RecordingIdentity', () => {
  it('resumes a released tab with a matching saved sequence', () => {
    const identity = new RecordingIdentity(resumableStorage(), () => 2_000, MAX_RECORDING_DURATION_MS)
    expect(identity.get('rum-session')).toBe('tab-replay')
  })

  it('starts a new replay when a live owner was copied into another tab', () => {
    const storage = resumableStorage()
    storage.setItem(RECORDING_OWNER_STORAGE_KEY, 'other-live-document')
    const identity = new RecordingIdentity(storage, () => 2_000, MAX_RECORDING_DURATION_MS)
    expect(identity.get('rum-session')).not.toBe('tab-replay')
  })

  it('does not resume released storage copied from an uninstrumented opener', () => {
    const opener = resumableStorage()
    const identity = new RecordingIdentity(
      resumableStorage(),
      () => 2_000,
      MAX_RECORDING_DURATION_MS,
      () => opener.getItem(RECORDING_STORAGE_KEY)
    )
    expect(identity.get('rum-session')).not.toBe('tab-replay')
  })

  it('continues a child tab after it has established its own recording', () => {
    const opener = resumableStorage()
    opener.setItem(RECORDING_STORAGE_KEY, JSON.stringify({ id: 'parent-replay', rumSessionId: 'rum-session', startedAt: 1_000 }))
    const identity = new RecordingIdentity(
      resumableStorage(),
      () => 2_000,
      MAX_RECORDING_DURATION_MS,
      () => opener.getItem(RECORDING_STORAGE_KEY)
    )
    expect(identity.get('rum-session')).toBe('tab-replay')
  })

  it('continues its own replay when the opener has become inaccessible', () => {
    const identity = new RecordingIdentity(
      resumableStorage(),
      () => 2_000,
      MAX_RECORDING_DURATION_MS,
      () => {
        throw new DOMException('Cross-origin opener', 'SecurityError')
      }
    )
    expect(identity.get('rum-session')).toBe('tab-replay')
  })

  it.each([
    null,
    '{',
    JSON.stringify({ id: 'other', seq: 7 }),
    JSON.stringify({ id: 'tab-replay', seq: -1 }),
    JSON.stringify({ id: 'tab-replay', seq: 1.5 }),
  ])('does not resume without a valid matching sequence: %s', (sequence) => {
    const storage = resumableStorage()
    if (sequence === null) {
      storage.removeItem(SEQ_STORAGE_KEY)
    } else {
      storage.setItem(SEQ_STORAGE_KEY, sequence)
    }
    const identity = new RecordingIdentity(storage, () => 2_000, MAX_RECORDING_DURATION_MS)
    expect(identity.get('rum-session')).not.toBe('tab-replay')
  })

  it('does not resume a persisted identity when ownership cannot be written', () => {
    const storage = resumableStorage()
    storage.setItem = () => {
      throw new Error('storage blocked')
    }
    const identity = new RecordingIdentity(storage, () => 2_000, MAX_RECORDING_DURATION_MS)
    expect(identity.get('rum-session')).not.toBe('tab-replay')
  })

  it('rotates at the two-hour boundary without changing RUM identity', () => {
    let now = 1_000 + MAX_RECORDING_DURATION_MS - 1
    const identity = new RecordingIdentity(resumableStorage(), () => now, 4 * 60 * 60 * 1_000)
    expect(identity.get('rum-session')).toBe('tab-replay')
    now += 1
    expect(identity.isCurrent('tab-replay', 'rum-session')).toBe(false)
    expect(identity.get('rum-session')).not.toBe('tab-replay')
  })

  it('does not resume a different RUM session or a future-dated recording', () => {
    const differentSession = new RecordingIdentity(resumableStorage(), () => 2_000, MAX_RECORDING_DURATION_MS)
    expect(differentSession.get('new-rum-session')).not.toBe('tab-replay')
    const futureRecording = new RecordingIdentity(resumableStorage(), () => 999, MAX_RECORDING_DURATION_MS)
    expect(futureRecording.get('rum-session')).not.toBe('tab-replay')
  })

  it('does not release an owner that has replaced this document', () => {
    const storage = resumableStorage()
    const identity = new RecordingIdentity(storage, () => 2_000, MAX_RECORDING_DURATION_MS)
    storage.setItem(RECORDING_OWNER_STORAGE_KEY, 'replacement-document')
    identity.release()
    expect(storage.getItem(RECORDING_OWNER_STORAGE_KEY)).toBe('replacement-document')
  })

  it('does not resume a cached document when its ownership write silently fails', () => {
    const storage = resumableStorage()
    const identity = new RecordingIdentity(storage, () => 2_000, MAX_RECORDING_DURATION_MS)
    expect(identity.get('rum-session')).toBe('tab-replay')
    identity.release()
    storage.setItem = () => {
      // Simulate storage that silently discards a write.
    }
    identity.resume()
    expect(identity.get('rum-session')).not.toBe('tab-replay')
  })

  it('does not resume a cached document over another live owner', () => {
    const storage = resumableStorage()
    const identity = new RecordingIdentity(storage, () => 2_000, MAX_RECORDING_DURATION_MS)
    identity.release()
    storage.setItem(RECORDING_OWNER_STORAGE_KEY, 'another-live-document')
    identity.resume()
    expect(identity.get('rum-session')).not.toBe('tab-replay')
  })
})
