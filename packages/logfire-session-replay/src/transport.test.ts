/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/require-await, @typescript-eslint/strict-void-return, vitest/require-mock-type-parameters, vitest/expect-expect, vitest/no-conditional-expect */
import type { gzip } from 'fflate'
import { gzipSync, gunzipSync, strFromU8, strToU8 } from 'fflate'
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

function immediateCompression() {
  return {
    gzip: ((input: Uint8Array, _options: unknown, callback: (error: Error | null, data: Uint8Array) => void) => {
      callback(null, gzipSync(input))
    }) as typeof gzip,
    gzipSync,
  }
}

function pseudoRandomText(length: number, seed: number): string {
  let state = seed >>> 0
  let value = ''
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    value += alphabet.charAt((state >>> 24) % alphabet.length)
  }
  return value
}

function largeEvent(timestamp: number, seed: number, length = 30_000): RrwebEvent {
  return {
    type: EventType.IncrementalSnapshot,
    data: { text: pseudoRandomText(length, seed) },
    timestamp,
  }
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

  it('uses UTF-8 bytes rather than UTF-16 code units for the buffer threshold', async () => {
    const event = { ...click, data: { text: 'é🚀'.repeat(20) } } satisfies RrwebEvent
    const json = JSON.stringify(event)
    const utf8Bytes = strToU8(json).byteLength
    expect(utf8Bytes).toBeGreaterThan(json.length)

    const { calls, fetchImpl } = recordingFetch()
    const transport = new ReplayTransport({ ...makeConfig(fetchImpl), maxBufferBytes: utf8Bytes }, 'sess-utf8', 'full', null)
    transport.add(event)
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1)
    })
    await transport.shutdown()
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

describe('ReplayTransport compression fallback', () => {
  it('recovers from an async gzip setup throw, memoizes it, and preserves both envelopes', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const asyncGzip = vi.fn(() => {
      throw new Error('worker construction blocked')
    }) as unknown as typeof gzip
    const transport = new ReplayTransport(makeConfig(fetchImpl), 'sess-csp', 'full', null, { gzip: asyncGzip, gzipSync })

    transport.add(fullSnapshot)
    await transport.flush()
    transport.add(click)
    await transport.flush()

    expect(asyncGzip).toHaveBeenCalledTimes(1)
    expect(calls.map((call) => decodeBody(call.init.body).events)).toEqual([[fullSnapshot], [click]])
  })

  it('recovers from an async gzip callback error without reporting it', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const onError = vi.fn()
    const asyncGzip = vi.fn((_input: Uint8Array, _options: unknown, callback: (error: Error | null, data: Uint8Array) => void) => {
      callback(new Error('worker rejected'), new Uint8Array())
    }) as unknown as typeof gzip
    const transport = new ReplayTransport({ ...makeConfig(fetchImpl), onError }, 'sess-csp', 'full', null, {
      gzip: asyncGzip,
      gzipSync,
    })
    transport.add(fullSnapshot)
    await transport.flush()

    expect(decodeBody(calls[0]!.init.body).events).toEqual([fullSnapshot])
    expect(onError).not.toHaveBeenCalled()
  })

  it('recovers when CSP blocks the worker without an fflate callback', async () => {
    const policyTarget = new EventTarget()
    vi.stubGlobal('window', policyTarget)
    try {
      const { calls, fetchImpl } = recordingFetch()
      const asyncGzip = vi.fn(() => undefined) as unknown as typeof gzip
      const transport = new ReplayTransport(makeConfig(fetchImpl), 'sess-csp-event', 'full', null, {
        gzip: asyncGzip,
        gzipSync,
      })
      transport.add(fullSnapshot)
      const flush = transport.flush()
      await vi.waitFor(() => {
        expect(asyncGzip).toHaveBeenCalledTimes(1)
      })
      const violation = new Event('securitypolicyviolation')
      Object.defineProperties(violation, {
        effectiveDirective: { value: 'worker-src' },
        violatedDirective: { value: 'worker-src' },
      })
      policyTarget.dispatchEvent(violation)
      await flush

      expect(decodeBody(calls[0]!.init.body).events).toEqual([fullSnapshot])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports once and sends nothing when async and sync compression both fail', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const onError = vi.fn()
    const asyncGzip = vi.fn(() => {
      throw new Error('worker blocked')
    }) as unknown as typeof gzip
    const syncGzip = vi.fn(() => {
      throw new Error('sync compressor failed')
    }) as unknown as typeof gzipSync
    const transport = new ReplayTransport({ ...makeConfig(fetchImpl), onError }, 'sess-csp', 'full', null, {
      gzip: asyncGzip,
      gzipSync: syncGzip,
    })
    transport.add(fullSnapshot)

    await expect(transport.flush()).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('ReplayTransport lifecycle keepalive budget', () => {
  it('starts an admitted contiguous prefix before responses and sends excess once without keepalive', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const releases: (() => void)[] = []
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      await new Promise<void>((resolve) => {
        releases.push(resolve)
      })
      return new Response(null, { status: 202 })
    }) as unknown as typeof fetch
    const transport = new ReplayTransport(makeConfig(fetchImpl), 'sess-budget', 'full', null, immediateCompression())
    transport.add(largeEvent(10, 1))
    transport.add(largeEvent(20, 2))
    transport.add(largeEvent(30, 3))

    const flush = transport.flush({ keepalive: true })
    await vi.waitFor(() => {
      expect(calls).toHaveLength(3)
    })
    const sizes = calls.map((call) => (call.init.body as Uint8Array).byteLength)
    expect(calls.map((call) => call.init.keepalive)).toEqual([true, true, false])
    expect(sizes[0]! + sizes[1]!).toBeLessThanOrEqual(48_000)
    expect(sizes[0]! + sizes[1]! + sizes[2]!).toBeGreaterThan(48_000)
    expect(calls.map((call) => call.url)).toEqual([
      'https://app.example.com/replay-proxy/sess-budget?seq=0',
      'https://app.example.com/replay-proxy/sess-budget?seq=1',
      'https://app.example.com/replay-proxy/sess-budget?seq=2',
    ])
    expect(calls.map((call) => decodeBody(call.init.body).events[0]?.timestamp)).toEqual([10, 20, 30])

    for (const release of releases) {
      release()
    }
    await flush
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('shares reservations across overlapping flushes and reclaims them only after response-body cancellation', async () => {
    let releaseCancellation!: () => void
    const cancellationGate = new Promise<void>((resolve) => {
      releaseCancellation = resolve
    })
    const keepaliveFlags: (boolean | undefined)[] = []
    let heldResponses = 0
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      keepaliveFlags.push(init?.keepalive)
      if (heldResponses < 3) {
        heldResponses += 1
        return new Response(
          new ReadableStream({
            cancel: async () => cancellationGate,
          }),
          { status: 202 }
        )
      }
      return new Response(null, { status: 202 })
    }) as unknown as typeof fetch
    const transport = new ReplayTransport(makeConfig(fetchImpl), 'sess-overlap', 'full', null, immediateCompression())

    transport.add(largeEvent(10, 1))
    transport.add(largeEvent(20, 2))
    const first = transport.flush({ keepalive: true })
    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    })
    transport.add(largeEvent(30, 3))
    const overlapping = transport.flush({ keepalive: true })
    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(3)
    })
    expect(keepaliveFlags).toEqual([true, true, false])

    releaseCancellation()
    await Promise.all([first, overlapping])
    transport.add(largeEvent(40, 4))
    await transport.flush({ keepalive: true })
    expect(keepaliveFlags).toEqual([true, true, false, true])
  })

  it('retains a reservation when response completion cannot be confirmed', async () => {
    const keepaliveFlags: (boolean | undefined)[] = []
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      keepaliveFlags.push(init?.keepalive)
      return new Response(
        new ReadableStream({
          cancel: () => {
            throw new Error('completion unknown')
          },
        }),
        { status: 202 }
      )
    }) as unknown as typeof fetch
    const transport = new ReplayTransport(makeConfig(fetchImpl), 'sess-unknown', 'full', null, immediateCompression())
    transport.add(largeEvent(10, 1))
    transport.add(largeEvent(20, 2))
    await transport.flush({ keepalive: true })
    transport.add(largeEvent(30, 3))
    await transport.flush({ keepalive: true })
    expect(keepaliveFlags).toEqual([true, true, false])
  })

  it.each(['credentials', 'network'] as const)('reclaims pre-completion capacity after %s failure', async (failure) => {
    const keepaliveFlags: (boolean | undefined)[] = []
    let attempts = 0
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      keepaliveFlags.push(init?.keepalive)
      attempts += 1
      if (failure === 'network' && attempts === 1) {
        throw new Error('network down')
      }
      return new Response(null, { status: 202 })
    }) as unknown as typeof fetch
    const headers = vi.fn(async () => {
      attempts += failure === 'credentials' ? 1 : 0
      if (failure === 'credentials' && attempts === 1) {
        throw new Error('credentials unavailable')
      }
      return {}
    })
    const transport = new ReplayTransport({ ...makeConfig(fetchImpl), headers }, 'sess-reclaim', 'full', null, immediateCompression())

    transport.add(largeEvent(10, 1))
    await transport.flush({ keepalive: true })
    transport.add(largeEvent(20, 2))
    await transport.flush({ keepalive: true })
    expect(keepaliveFlags.at(-1)).toBe(true)
  })

  it('attempts an over-budget lifecycle 429 once and reports it once', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) => new Response(null, { status: 429, headers: { 'retry-after': '1' } })
    )
    const fetchImpl = fetchMock as unknown as typeof fetch
    const onError = vi.fn()
    const transport = new ReplayTransport({ ...makeConfig(fetchImpl), onError }, 'sess-once', 'full', null, immediateCompression())
    transport.add(largeEvent(10, 1, 70_000))
    await transport.flush({ keepalive: true })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[1]?.keepalive).toBe(false)
    expect(onError).toHaveBeenCalledTimes(1)
  })
})

describe('ReplayTransport Retry-After policy', () => {
  async function expectRetryAfter(header: string | null, delayMs: number, now = '1994-11-06T08:49:36.000Z'): Promise<void> {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(now))
    try {
      let attempts = 0
      const fetchImpl = vi.fn(async () => {
        attempts += 1
        return attempts === 1
          ? new Response(null, header === null ? { status: 429 } : { status: 429, headers: { 'retry-after': header } })
          : new Response(null, { status: 202 })
      }) as unknown as typeof fetch
      const transport = new ReplayTransport(makeConfig(fetchImpl), 'sess-retry-after', 'full', null, immediateCompression())
      transport.add(fullSnapshot)
      const flush = transport.flush()
      await vi.advanceTimersByTimeAsync(0)
      if (delayMs > 0) {
        expect(fetchImpl).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(delayMs - 1)
        expect(fetchImpl).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1)
      } else {
        expect(fetchImpl).toHaveBeenCalledTimes(2)
      }
      await flush
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  }

  it.each([
    ['1', 1_000],
    ['Sun, 06 Nov 1994 08:49:37 GMT', 1_000],
    ['Sunday, 06-Nov-94 08:49:37 GMT', 1_000],
    ['Sun Nov  6 08:49:37 1994', 1_000],
    ['Sun, 06 Nov 1994 08:49:35 GMT', 0],
  ] as const)('honors Retry-After %s', async (header, delayMs) => {
    await expectRetryAfter(header, delayMs)
  })

  it('applies the RFC850 more-than-50-years rollback', async () => {
    await expectRetryAfter('Sunday, 06-Nov-77 08:49:37 GMT', 0, '2026-07-13T00:00:00.000Z')
  })

  it.each(['Sun, 31 Feb 1994 08:49:37 GMT', '1994-11-06T08:49:37Z', 'tomorrow', '+1', '1.5', '999999999999999999999999999999'])(
    'uses ordinary backoff for invalid Retry-After %s',
    async (header) => {
      await expectRetryAfter(header, 500)
    }
  )

  it('does not retry early when valid guidance exceeds ten seconds', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn(async () => new Response(null, { status: 429, headers: { 'retry-after': '11' } })) as unknown as typeof fetch
      const onError = vi.fn()
      const transport = new ReplayTransport({ ...makeConfig(fetchImpl), onError }, 'sess-long', 'full', null, immediateCompression())
      transport.add(fullSnapshot)
      await transport.flush()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(onError).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses 500ms then 1000ms fallback, exhausts three attempts, and refreshes credentials', async () => {
    vi.useFakeTimers()
    try {
      const bodies: Uint8Array[] = []
      const urls: string[] = []
      const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
        urls.push(String(url))
        bodies.push(init?.body as Uint8Array)
        return new Response(null, { status: 429 })
      }) as unknown as typeof fetch
      const token = vi.fn(async () => 'fresh-token')
      const headers = vi.fn(async () => ({ 'X-Attempt': String(token.mock.calls.length + 1) }))
      const onError = vi.fn()
      const transport = new ReplayTransport(
        { ...makeConfig(fetchImpl), token, headers, onError },
        'sess-exhausted',
        'full',
        null,
        immediateCompression()
      )
      transport.add(fullSnapshot)
      const flush = transport.flush()
      await vi.advanceTimersByTimeAsync(500)
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1_000)
      await flush

      expect(fetchImpl).toHaveBeenCalledTimes(3)
      expect(token).toHaveBeenCalledTimes(3)
      expect(headers).toHaveBeenCalledTimes(3)
      expect(urls).toEqual(Array(3).fill('https://app.example.com/replay-proxy/sess-exhausted?seq=0'))
      expect(bodies.map((body) => Array.from(body))).toEqual(Array(3).fill(Array.from(bodies[0]!)))
      expect(onError).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
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
