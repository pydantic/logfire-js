/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SequenceRecords, writableLocalStorage } from './sequenceRecord'

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('SequenceRecords', () => {
  it('reads back the sequence it wrote for a recording', () => {
    const records = new SequenceRecords(localStorage, () => 5_000)

    expect(records.write('recording-a', 7)).toBe(true)

    expect(records.read('recording-a')).toBe(7)
    expect(records.read('recording-b')).toBeUndefined()
    expect(localStorage.getItem('lf_session_replay_seq:recording-a')).toBe(JSON.stringify({ seq: 7, at: 5_000 }))
  })

  it('reports a write that throws', () => {
    const storage = memoryStorage({
      setItem: () => {
        throw new DOMException('quota exceeded', 'QuotaExceededError')
      },
    })

    expect(new SequenceRecords(storage, () => 0).write('recording-a', 1)).toBe(false)
  })

  it('reports a write that the browser discards without an error', () => {
    const storage = memoryStorage({ setItem: () => undefined })

    expect(new SequenceRecords(storage, () => 0).write('recording-a', 1)).toBe(false)
  })

  it('ignores a malformed record', () => {
    localStorage.setItem('lf_session_replay_seq:recording-a', JSON.stringify({ seq: -1, at: 0 }))

    expect(new SequenceRecords(localStorage, () => 0).read('recording-a')).toBeUndefined()
  })

  it('prunes old and malformed records and keeps recent records and other keys', () => {
    localStorage.setItem('lf_session_replay_seq:old', JSON.stringify({ seq: 3, at: 1_000 }))
    localStorage.setItem('lf_session_replay_seq:recent', JSON.stringify({ seq: 4, at: 9_000 }))
    localStorage.setItem('lf_session_replay_seq:broken', 'not json')
    localStorage.setItem('unrelated', 'kept')

    new SequenceRecords(localStorage, () => 10_000).prune(5_000)

    expect(localStorage.getItem('lf_session_replay_seq:old')).toBeNull()
    expect(localStorage.getItem('lf_session_replay_seq:broken')).toBeNull()
    expect(localStorage.getItem('lf_session_replay_seq:recent')).toBe(JSON.stringify({ seq: 4, at: 9_000 }))
    expect(localStorage.getItem('unrelated')).toBe('kept')
  })
})

describe('writableLocalStorage', () => {
  it('returns localStorage when a probe write reads back', () => {
    expect(writableLocalStorage()).toBe(localStorage)
    expect(localStorage.getItem('lf_session_replay_probe')).toBeNull()
  })

  it('returns null when localStorage throws', () => {
    vi.stubGlobal(
      'localStorage',
      memoryStorage({
        setItem: () => {
          throw new DOMException('denied', 'SecurityError')
        },
      })
    )

    expect(writableLocalStorage()).toBeNull()
  })
})

function memoryStorage(overrides: Partial<Pick<Storage, 'setItem'>> = {}): Storage {
  const values = new Map<string, string>()
  return {
    clear: () => {
      values.clear()
    },
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => {
      values.delete(key)
    },
    setItem:
      overrides.setItem ??
      ((key, value) => {
        values.set(key, value)
      }),
    get length() {
      return values.size
    },
  }
}
