/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/require-await, @typescript-eslint/strict-void-return, vitest/require-mock-type-parameters */
import { gunzipSync, strFromU8 } from 'fflate'
import { describe, expect, it, vi } from 'vitest'

import { ReplayTransport, SEQ_STORAGE_KEY } from './transport'
import { CHUNK_ENVELOPE_VERSION, EventType, IncrementalSource, MouseInteractions } from './types'
import type { ChunkEnvelope, ResolvedSessionReplayConfig, RrwebEvent } from './types'

const fullSnapshot: RrwebEvent = { type: EventType.FullSnapshot, data: { node: {} }, timestamp: 1 }
const click: RrwebEvent = {
  type: EventType.IncrementalSnapshot,
  data: { source: IncrementalSource.MouseInteraction, type: MouseInteractions.Click },
  timestamp: 2,
}

function makeConfig(fetchImpl: typeof fetch): ResolvedSessionReplayConfig {
  return {
    replayUrl: 'https://app.example.com/replay-proxy',
    headers: undefined,
    token: undefined,
    getSessionId: undefined,
    sessionSampleRate: 1,
    onErrorSampleRate: 1,
    maskAllInputs: true,
    maskTextSelector: '',
    blockSelector: '',
    flushIntervalMs: 5_000,
    maxBufferBytes: 1_000_000,
    sessionIdleTimeoutMs: 1_000,
    maxSessionDurationMs: 10_000,
    distinctId: 'user-1',
    getDistinctId: undefined,
    getTraceContext: undefined,
    captureConsole: true,
    captureNetwork: true,
    captureNavigation: true,
    ignoreUrlPatterns: [],
    redactUrlPatterns: [],
    onError: undefined,
    fetchImpl,
    now: () => 1_000,
    random: () => 0,
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

describe('ReplayTransport full mode', () => {
  it('uploads one gzipped envelope to the proxy URL with seq=0', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const transport = new ReplayTransport(makeConfig(fetchImpl), 'sess-1', 'full', null)
    transport.add(fullSnapshot)
    transport.add(click)
    await transport.flush()

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://app.example.com/replay-proxy/sess-1?seq=0')
    expect(calls[0]!.init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
    })

    const envelope = decodeBody(calls[0]!.init.body)
    expect(envelope.version).toBe(CHUNK_ENVELOPE_VERSION)
    expect(envelope.events).toHaveLength(2)
    expect(envelope.meta.clickCount).toBe(1)
    expect(envelope.meta.hasFullSnapshot).toBe(true)
    expect(envelope.meta.distinctId).toBe('user-1')
  })

  it('merges async headers and direct token auth', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const config: ResolvedSessionReplayConfig = {
      ...makeConfig(fetchImpl),
      headers: async () => ({ 'X-CSRF': 'csrf-token' }),
      token: async () => 'write-token',
    }
    const transport = new ReplayTransport(config, 'sess-token', 'full', null)
    transport.add(fullSnapshot)
    await transport.flush()

    expect(calls[0]!.init.headers).toMatchObject({
      Authorization: 'Bearer write-token',
      'X-CSRF': 'csrf-token',
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
    })
  })

  it('uses getDistinctId over static distinctId when provided', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const transport = new ReplayTransport({ ...makeConfig(fetchImpl), getDistinctId: () => 'signed-in-user' }, 'sess-x', 'full', null)
    transport.add(fullSnapshot)
    await transport.flush()
    expect(decodeBody(calls[0]!.init.body).meta.distinctId).toBe('signed-in-user')
  })

  it('auto-flushes when the buffer crosses maxBufferBytes', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const transport = new ReplayTransport({ ...makeConfig(fetchImpl), maxBufferBytes: 80 }, 'sess-cap', 'full', null)
    transport.add(fullSnapshot)
    expect(calls).toHaveLength(0)
    transport.add(click)
    await transport.shutdown()
    expect(calls).toHaveLength(1)
    expect(decodeBody(calls[0]!.init.body).events.map((event) => event.timestamp)).toEqual([1, 2])
  })

  it('increments seq on each non-empty flush', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const transport = new ReplayTransport(makeConfig(fetchImpl), 'sess-1', 'full', null)
    transport.add(fullSnapshot)
    await transport.flush()
    await transport.flush()
    transport.add(click)
    await transport.flush()
    expect(calls.map((call) => call.url)).toEqual([
      'https://app.example.com/replay-proxy/sess-1?seq=0',
      'https://app.example.com/replay-proxy/sess-1?seq=1',
    ])
  })
})

describe('ReplayTransport retries', () => {
  it('retries transient failures', async () => {
    let attempts = 0
    const fetchImpl = vi.fn(async () => {
      attempts += 1
      if (attempts === 1) {
        throw new Error('network down')
      }
      return { ok: true, status: 202 } as Response
    }) as unknown as typeof fetch
    const onError = vi.fn()
    const transport = new ReplayTransport({ ...makeConfig(fetchImpl), onError }, 'sess-r', 'full', null)
    transport.add(fullSnapshot)
    await transport.flush()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(onError).not.toHaveBeenCalled()
  })

  it('does not retry 4xx responses and reports the error', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 400 }) as Response) as unknown as typeof fetch
    const onError = vi.fn()
    const transport = new ReplayTransport({ ...makeConfig(fetchImpl), onError }, 'sess-r', 'full', null)
    transport.add(fullSnapshot)
    await transport.flush()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('does not retry keepalive flushes', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const onError = vi.fn()
    const transport = new ReplayTransport({ ...makeConfig(fetchImpl), onError }, 'sess-r', 'full', null)
    transport.add(fullSnapshot)
    await transport.flush({ keepalive: true })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('starts a keepalive flush while an ordinary upload is still in flight', async () => {
    let releaseFirst: ((response: Response) => void) | undefined
    let callCount = 0
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      callCount += 1
      if (callCount === 1) {
        return new Promise<Response>((resolve) => {
          releaseFirst = resolve
        })
      }
      return { ok: true, status: 202 } as Response
    })
    const fetchImpl = fetchMock as unknown as typeof fetch
    const transport = new ReplayTransport(makeConfig(fetchImpl), 'sess-pagehide', 'full', null)
    transport.add(fullSnapshot)
    const ordinaryFlush = transport.flush()
    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    transport.add(click)
    const keepaliveFlush = transport.flush({ keepalive: true })
    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    })
    expect(fetchMock.mock.calls[1]?.[1]?.keepalive).toBe(true)

    releaseFirst?.({ ok: true, status: 202 } as Response)
    await Promise.all([ordinaryFlush, keepaliveFlush])
  })

  it('splits large keepalive flushes into ordered chunks', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const transport = new ReplayTransport(makeConfig(fetchImpl), 'sess-large', 'full', null)
    const largeEvent = {
      type: EventType.IncrementalSnapshot,
      data: { text: 'x'.repeat(50_000) },
      timestamp: 10,
    } satisfies RrwebEvent
    transport.add({ ...largeEvent, timestamp: 10 })
    transport.add({ ...largeEvent, timestamp: 20 })
    transport.add({ ...largeEvent, timestamp: 30 })

    await transport.flush({ keepalive: true })

    expect(calls.map((call) => call.url)).toEqual([
      'https://app.example.com/replay-proxy/sess-large?seq=0',
      'https://app.example.com/replay-proxy/sess-large?seq=1',
      'https://app.example.com/replay-proxy/sess-large?seq=2',
    ])
    expect(calls.map((call) => call.init.keepalive)).toEqual([true, true, true])
    expect(calls.map((call) => decodeBody(call.init.body).events.map((event) => event.timestamp))).toEqual([[10], [20], [30]])
  })
})

describe('ReplayTransport buffer mode', () => {
  it('does not upload until triggered', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const transport = new ReplayTransport(makeConfig(fetchImpl), 'sess-2', 'buffer', null)
    transport.add(fullSnapshot)
    transport.add(click)
    await transport.flush()
    expect(calls).toHaveLength(0)

    await transport.triggerFlush()
    expect(calls).toHaveLength(1)
    expect(decodeBody(calls[0]!.init.body).events).toHaveLength(2)
  })

  it('drops buffered events before the latest full snapshot', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const transport = new ReplayTransport(makeConfig(fetchImpl), 'sess-3', 'buffer', null)
    transport.add(fullSnapshot)
    transport.add(click)
    transport.add({ ...fullSnapshot, timestamp: 10 })
    await transport.triggerFlush()
    expect(decodeBody(calls[0]!.init.body).events.map((event) => event.timestamp)).toEqual([10])
  })
})

describe('ReplayTransport session rotation and sequence persistence', () => {
  it('ships old full-mode tail under the old id and resets seq for the new id', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const transport = new ReplayTransport(makeConfig(fetchImpl), 'old', 'full', null)
    transport.add(fullSnapshot)
    await transport.flush()
    transport.add(click)
    expect(transport.rotate('new')).toBe(true)
    transport.add({ ...fullSnapshot, timestamp: 20 })
    await transport.flush()
    await transport.shutdown()

    expect(calls.map((call) => call.url)).toEqual([
      'https://app.example.com/replay-proxy/old?seq=0',
      'https://app.example.com/replay-proxy/old?seq=1',
      'https://app.example.com/replay-proxy/new?seq=0',
    ])
  })

  it('drops an untriggered buffer-mode tail on rotation', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const transport = new ReplayTransport(makeConfig(fetchImpl), 'old', 'buffer', null)
    transport.add(fullSnapshot)
    transport.add(click)
    expect(transport.rotate('new')).toBe(true)
    transport.add({ ...fullSnapshot, timestamp: 20 })
    await transport.triggerFlush()
    expect(calls.map((call) => call.url)).toEqual(['https://app.example.com/replay-proxy/new?seq=0'])
    expect(decodeBody(calls[0]!.init.body).events.map((event) => event.timestamp)).toEqual([20])
  })

  it('resumes seq across page loads for the same session id', async () => {
    const storage = memoryStorage()
    const { calls, fetchImpl } = recordingFetch()
    const page1 = new ReplayTransport(makeConfig(fetchImpl), 'S', 'full', storage)
    page1.add(fullSnapshot)
    await page1.flush()
    page1.add(click)
    await page1.flush()

    const page2 = new ReplayTransport(makeConfig(fetchImpl), 'S', 'full', storage)
    page2.add(fullSnapshot)
    await page2.flush()

    expect(calls.map((call) => call.url)).toEqual([
      'https://app.example.com/replay-proxy/S?seq=0',
      'https://app.example.com/replay-proxy/S?seq=1',
      'https://app.example.com/replay-proxy/S?seq=2',
    ])
    expect(storage.getItem(SEQ_STORAGE_KEY)).toBe(JSON.stringify({ id: 'S', seq: 3 }))
  })

  it('serializes concurrent flushes across a rotation', async () => {
    const calls: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let first = true
    const fetchImpl = vi.fn(async (url: string | URL) => {
      calls.push(String(url))
      if (first) {
        first = false
        await gate
      }
      return { ok: true, status: 202 } as Response
    }) as unknown as typeof fetch

    const transport = new ReplayTransport(makeConfig(fetchImpl), 'old', 'full', null)
    transport.add(fullSnapshot)
    const firstFlush = transport.flush()
    transport.rotate('new')
    transport.add(click)
    const secondFlush = transport.flush()
    release()
    await Promise.all([firstFlush, secondFlush])

    expect(calls).toEqual(['https://app.example.com/replay-proxy/old?seq=0', 'https://app.example.com/replay-proxy/new?seq=0'])
  })
})

function memoryStorage(): Storage {
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
    setItem: (key, value) => {
      values.set(key, value)
    },
    get length() {
      return values.size
    },
  }
}
