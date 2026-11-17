/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { TraceExportStorage } from './TraceExportStorage'

const body = JSON.stringify({ resourceSpans: [] })

afterEach(() => {
  vi.restoreAllMocks()
  sessionStorage.clear()
})

describe('TraceExportStorage', () => {
  it('isolates destinations and removes only the acknowledged request', () => {
    const first = new TraceExportStorage(sessionStorage, 'first', 'owner')
    const second = new TraceExportStorage(sessionStorage, 'second', 'owner')
    const key = first.save(body) ?? ''
    const newer = first.save(body) ?? ''
    second.save(body)
    first.remove(key)
    expect(first.read().map((record) => record.key)).toEqual([newer])
    expect(second.read().map((record) => record.body)).toEqual([body])
  })

  it('bounds the total across destinations and evicts the oldest records', () => {
    const storage = new TraceExportStorage(sessionStorage, 'first', 'owner')
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    storage.save(JSON.stringify({ resourceSpans: [], padding: 'x'.repeat(600_000) }))
    vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const second = new TraceExportStorage(sessionStorage, 'second', 'owner')
    second.save(JSON.stringify({ resourceSpans: [], padding: 'y'.repeat(600_000) }))
    expect(storage.read()).toEqual([])
    expect(second.read()).toHaveLength(1)
    expect(storage.save('x'.repeat(2 * 1024 * 1024))).toBeUndefined()
    expect(second.read()).toHaveLength(1)
  })

  it('keeps at most 32 requests', () => {
    const storage = new TraceExportStorage(sessionStorage, 'scope', 'owner')
    for (let index = 0; index < 33; index += 1) {
      storage.save(body)
    }
    expect(storage.read()).toHaveLength(32)
  })

  it('expires old requests and removes corrupt records without touching application storage', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const storage = new TraceExportStorage(sessionStorage, 'scope', 'owner')
    storage.save(body)
    sessionStorage.setItem('logfire:traces:v2:scope:broken', 'not json')
    sessionStorage.setItem('application', 'keep')
    vi.spyOn(Date, 'now').mockReturnValue(301_000)
    expect(storage.read()).toEqual([])
    expect(sessionStorage.length).toBe(1)
    expect(sessionStorage.getItem('application')).toBe('keep')
  })

  it('tolerates unavailable or full storage', () => {
    const storage = new TraceExportStorage(sessionStorage, 'scope', 'owner')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(storage.save(body)).toBeUndefined()
    vi.spyOn(Storage.prototype, 'key').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(storage.read()).toEqual([])
  })
})
