/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/require-await, @typescript-eslint/strict-void-return, vitest/require-mock-type-parameters, vitest/expect-expect, vitest/no-conditional-expect */
import type { gzip } from 'fflate'
import { gzipSync, gunzipSync, strFromU8, strToU8 } from 'fflate'
import { describe, expect, it, vi } from 'vitest'

import { ReplayTransport, SEQ_STORAGE_KEY } from './transport'
import { CHUNK_ENVELOPE_VERSION, EventType, IncrementalSource, MouseInteractions } from './types'
import { ReplayUploadError } from './uploadError'
import type { ChunkEnvelope, ResolvedSessionReplayConfig, RrwebEvent } from './types'

const meta: RrwebEvent = {
  type: EventType.Meta,
  data: { href: 'https://app.example.com/orders', height: 720, width: 1_280 },
  timestamp: 0,
}
const fullSnapshot: RrwebEvent = { type: EventType.FullSnapshot, data: { node: {} }, timestamp: 1 }
const click: RrwebEvent = {
  type: EventType.IncrementalSnapshot,
  data: { source: IncrementalSource.MouseInteraction, type: MouseInteractions.Click },
  timestamp: 2,
}
const mutation: RrwebEvent = {
  type: EventType.IncrementalSnapshot,
  data: { source: IncrementalSource.Mutation },
  timestamp: 3,
}
const REPLAY_UPLOAD_TIMEOUT_MS = 10_000

function makeConfig(fetchImpl: typeof fetch): ResolvedSessionReplayConfig {
  return {
    replayUrl: 'https://app.example.com/replay-proxy',
    headers: undefined,
    token: undefined,
    getSessionId: undefined,
    getSessionAttributes: undefined,
    sessionSampleRate: 1,
    onErrorSampleRate: 1,
    maskAllText: true,
    maskAllInputs: true,
    maskTextSelector: '',
    blockSelector: '',
    flushIntervalMs: 5_000,
    maxBufferBytes: 1_000_000,
    minSessionDurationMs: 0,
    sessionIdleTimeoutMs: 1_000,
    maxSessionDurationMs: 10_000,
    distinctId: 'user-1',
    getDistinctId: undefined,
    getUser: undefined,
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

function timedTransport(fetchImpl: typeof fetch, sessionId: string, overrides: Partial<ResolvedSessionReplayConfig> = {}) {
  return new ReplayTransport(
    { ...makeConfig(fetchImpl), ...overrides, now: () => Date.now() },
    sessionId,
    'full',
    null,
    immediateCompression()
  )
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
  it('retains metadata when releasing a complete held session', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const transport = new ReplayTransport(
      makeConfig(fetchImpl),
      'sess-held-complete',
      'full',
      null,
      immediateCompression(),
      {},
      { holdUntilActivity: true }
    )
    transport.start()
    transport.add(meta)
    transport.add(fullSnapshot)

    const takeFullSnapshot = vi.fn<() => void>()
    transport.releaseHeld(takeFullSnapshot)
    transport.add(click)
    await transport.shutdown()

    expect(takeFullSnapshot).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
    const envelope = decodeBody(calls[0]!.init.body)
    expect(envelope.events).toEqual([meta, fullSnapshot, click])
    expect(envelope.meta.urls).toEqual(['https://app.example.com/orders'])
  })

  it('keeps a rotated session bounded and unshipped until activity', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const firstIncremental = { ...click, timestamp: 2 }
    const secondIncremental = { ...click, timestamp: 3 }
    const replacementMeta = {
      ...meta,
      data: { href: 'https://app.example.com/account', height: 720, width: 1_280 },
      timestamp: 9,
    }
    const replacementSnapshot = { ...fullSnapshot, timestamp: 10 }
    const releasedClick = { ...click, timestamp: 11 }
    const maxBufferBytes =
      strToU8(JSON.stringify(meta)).byteLength +
      strToU8(JSON.stringify(fullSnapshot)).byteLength +
      strToU8(JSON.stringify(firstIncremental)).byteLength
    const transport = new ReplayTransport(
      { ...makeConfig(fetchImpl), maxBufferBytes },
      'sess-held',
      'full',
      null,
      immediateCompression(),
      {},
      { holdUntilActivity: true }
    )
    transport.start()
    transport.add(meta)
    transport.add(fullSnapshot)
    transport.add(firstIncremental)
    transport.add(secondIncremental)
    await transport.flush({ keepalive: true })
    expect(calls).toHaveLength(0)

    transport.releaseHeld(() => {
      transport.add(replacementMeta)
      transport.add(replacementSnapshot)
    })
    transport.add(releasedClick)
    await transport.shutdown()

    expect(calls).toHaveLength(1)
    const envelope = decodeBody(calls[0]!.init.body)
    expect(envelope.events).toEqual([replacementMeta, replacementSnapshot, releasedClick])
    expect(envelope.meta.urls).toEqual(['https://app.example.com/account'])
  })

  it('discards an unreleased rotated session on shutdown', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const transport = new ReplayTransport(
      makeConfig(fetchImpl),
      'sess-held-stop',
      'full',
      null,
      immediateCompression(),
      {},
      {
        holdUntilActivity: true,
      }
    )
    transport.start()
    transport.add(fullSnapshot)

    await transport.shutdown()

    expect(calls).toHaveLength(0)
  })

  it('uploads one gzipped envelope to the proxy URL with seq=0', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const transport = new ReplayTransport(makeConfig(fetchImpl), 'sess-1', 'full', null)
    transport.add(fullSnapshot)
    transport.add(click)
    await transport.flush()

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://app.example.com/replay-proxy/sess-1?seq=0')
    expect(calls[0]!.init.headers).toEqual({
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
    })

    const envelope = decodeBody(calls[0]!.init.body)
    expect(envelope.version).toBe(CHUNK_ENVELOPE_VERSION)
    expect(envelope.events).toHaveLength(2)
    expect(envelope.meta.clickCount).toBe(1)
    expect(envelope.meta.hasFullSnapshot).toBe(true)
    expect(envelope.meta.distinctId).toBe('user-1')
    expect(envelope.meta).not.toHaveProperty('traceIds')
  })

  it('copies one session snapshot into every chunk and omits an empty snapshot', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const sessionAttributes = { account_tier: 'pro', beta_user: true }
    const transport = new ReplayTransport(makeConfig(fetchImpl), 'sess-dimensions', 'full', null, immediateCompression(), sessionAttributes)
    sessionAttributes.account_tier = 'changed'
    transport.add(fullSnapshot)
    await transport.flush()
    transport.add(click)
    await transport.flush()

    expect(calls.map((call) => decodeBody(call.init.body).meta.sessionAttributes)).toEqual([
      { account_tier: 'pro', beta_user: true },
      { account_tier: 'pro', beta_user: true },
    ])

    const emptyRecording = recordingFetch()
    const emptyTransport = new ReplayTransport(makeConfig(emptyRecording.fetchImpl), 'sess-empty', 'full', null, immediateCompression(), {})
    emptyTransport.add(fullSnapshot)
    await emptyTransport.flush()
    expect(decodeBody(emptyRecording.calls[0]!.init.body).meta).not.toHaveProperty('sessionAttributes')
  })

  it('merges async headers and direct token auth', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const config: ResolvedSessionReplayConfig = {
      ...makeConfig(fetchImpl),
      headers: async () => ({ 'X-CSRF': 'csrf-token', authorization: 'Bearer stale-token' }),
      token: async () => 'write-token',
    }
    const transport = new ReplayTransport(config, 'sess-token', 'full', null)
    transport.add(fullSnapshot)
    await transport.flush()

    expect(calls[0]!.init.headers).toEqual({
      Authorization: 'Bearer write-token',
      'X-CSRF': 'csrf-token',
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
    })
  })

  it('keeps caller Authorization headers when the direct token is empty', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const transport = new ReplayTransport(
      {
        ...makeConfig(fetchImpl),
        headers: async () => ({ authorization: 'Bearer caller-token' }),
        token: async () => '',
      },
      'sess-header-token',
      'full',
      null
    )
    transport.add(fullSnapshot)
    await transport.flush()

    expect(calls[0]!.init.headers).toEqual({
      authorization: 'Bearer caller-token',
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

  describe('user context', () => {
    async function flushChunks(config: Partial<ResolvedSessionReplayConfig>, chunks: number, between?: (index: number) => void) {
      const { calls, fetchImpl } = recordingFetch()
      const transport = new ReplayTransport({ ...makeConfig(fetchImpl), ...config }, 'sess-user', 'full', null, immediateCompression())
      for (let index = 0; index < chunks; index++) {
        between?.(index)
        transport.add(index === 0 ? fullSnapshot : click)
        // eslint-disable-next-line no-await-in-loop -- each flush must produce its own chunk before the user changes.
        await transport.flush()
      }
      return calls.map((call) => decodeBody(call.init.body).meta)
    }

    it('reports an id-only user and derives distinctId from the same snapshot', async () => {
      const [meta] = await flushChunks({ getUser: () => ({ id: 'user-a' }) }, 1)
      expect(meta?.user).toEqual({ id: 'user-a' })
      expect(meta?.distinctId).toBe('user-a')
    })

    it('reports a full user and drops fields outside id, name and email', async () => {
      const getUser = () => ({ id: 'user-a', name: 'Ada', email: 'ada@example.com', role: 'admin', token: 'secret' })
      const [meta] = await flushChunks({ getUser }, 1)
      expect(meta?.user).toEqual({ id: 'user-a', name: 'Ada', email: 'ada@example.com' })
    })

    it('omits user on anonymous chunks and keeps the static distinctId', async () => {
      const [meta] = await flushChunks({ getUser: () => undefined }, 1)
      expect(meta).not.toHaveProperty('user')
      expect(meta?.distinctId).toBe('user-1')
    })

    it('follows login, a user switch, and logout across chunks', async () => {
      const users = [undefined, { id: 'user-a', name: 'Ada' }, { id: 'user-b', email: 'bo@example.com' }, undefined]
      let current: (typeof users)[number]
      const metas = await flushChunks({ distinctId: '', getUser: () => current }, users.length, (index) => {
        current = users[index]
      })
      expect(metas.map((meta) => meta.user)).toEqual([
        undefined,
        { id: 'user-a', name: 'Ada' },
        { id: 'user-b', email: 'bo@example.com' },
        undefined,
      ])
      expect(metas.map((meta) => meta.distinctId)).toEqual([undefined, 'user-a', 'user-b', undefined])
    })

    it('snapshots the user once per chunk', async () => {
      const users = [{ id: 'user-a' }, { id: 'user-b' }]
      let calls = 0
      const [meta] = await flushChunks({ getUser: () => users[calls++] }, 1)
      expect(calls).toBe(1)
      expect(meta?.user).toEqual({ id: 'user-a' })
      expect(meta?.distinctId).toBe('user-a')
    })

    it('keeps an explicit getDistinctId separate from user.id', async () => {
      const [meta] = await flushChunks({ getDistinctId: () => 'replay-identity', getUser: () => ({ id: 'user-a' }) }, 1)
      expect(meta?.distinctId).toBe('replay-identity')
      expect(meta?.user).toEqual({ id: 'user-a' })
    })

    it('omits user and reports the error when the callback fails', async () => {
      const failure = new Error('user lookup failed')
      const onError = vi.fn()
      const [meta] = await flushChunks(
        {
          getUser: () => {
            throw failure
          },
          onError,
        },
        1
      )
      expect(meta).not.toHaveProperty('user')
      expect(meta?.distinctId).toBe('user-1')
      expect(onError).toHaveBeenCalledWith(failure)
    })

    it('keeps the user of the recorded events when an earlier upload delays delivery', async () => {
      let releaseFirst: ((response: Response) => void) | undefined
      const bodies: BodyInit[] = []
      const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(init?.body as BodyInit)
        if (bodies.length === 1) {
          return new Promise<Response>((resolve) => {
            releaseFirst = resolve
          })
        }
        return { ok: true, status: 202 } as Response
      }) as unknown as typeof fetch
      let user: { id: string } | undefined = { id: 'user-a' }
      const transport = new ReplayTransport(
        { ...makeConfig(fetchImpl), getUser: () => user },
        'sess-queued',
        'full',
        null,
        immediateCompression()
      )

      transport.add(fullSnapshot)
      const firstFlush = transport.flush()
      await vi.waitFor(() => {
        expect(bodies).toHaveLength(1)
      })
      transport.add(click)
      const secondFlush = transport.flush()
      user = { id: 'user-b' }
      releaseFirst?.({ ok: true, status: 202 } as Response)
      await Promise.all([firstFlush, secondFlush])

      expect(bodies.map((body) => decodeBody(body).meta.user)).toEqual([{ id: 'user-a' }, { id: 'user-a' }])
      expect(bodies.map((body) => decodeBody(body).meta.distinctId)).toEqual(['user-a', 'user-a'])
    })

    it('leaves metadata unchanged without getUser', async () => {
      const [meta] = await flushChunks({}, 1)
      expect(meta).not.toHaveProperty('user')
      expect(meta?.distinctId).toBe('user-1')
    })
  })

  it('auto-flushes when the buffer crosses maxBufferBytes', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const transport = new ReplayTransport({ ...makeConfig(fetchImpl), maxBufferBytes: 80 }, 'sess-cap', 'full', null)
    transport.add(fullSnapshot)
    expect(calls).toHaveLength(0)
    transport.add(click)
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1)
    })
    expect(decodeBody(calls[0]!.init.body).events.map((event) => event.timestamp)).toEqual([1, 2])
    await transport.shutdown()
    expect(calls).toHaveLength(1)
  })

  it('waits until the minimum session duration before uploading', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const { calls, fetchImpl } = recordingFetch()
      const transport = timedTransport(fetchImpl, 'sess-minimum', {
        flushIntervalMs: 1_000,
        minSessionDurationMs: 5_000,
      })
      transport.start()
      transport.add(fullSnapshot)

      await transport.flush({ keepalive: true })
      await vi.advanceTimersByTimeAsync(4_999)
      expect(calls).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
      const endOfMinimum = { ...mutation, timestamp: 5_001 }
      transport.add(endOfMinimum)
      await vi.waitFor(() => {
        expect(calls).toHaveLength(1)
      })
      expect(decodeBody(calls[0]!.init.body).events).toEqual([fullSnapshot, endOfMinimum])
      await transport.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })

  it('discards a replay stopped before the minimum session duration', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const { calls, fetchImpl } = recordingFetch()
      const transport = timedTransport(fetchImpl, 'sess-short', { minSessionDurationMs: 5_000 })
      transport.start()
      transport.add(fullSnapshot)

      await vi.advanceTimersByTimeAsync(4_999)
      await transport.shutdown()
      await vi.advanceTimersByTimeAsync(1)

      expect(calls).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds a buffer-limit flush until the minimum session duration', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const { calls, fetchImpl } = recordingFetch()
      const refreshedSnapshot = { ...fullSnapshot, timestamp: 5_001 }
      const takeFullSnapshot = vi.fn()
      const transport = new ReplayTransport(
        { ...makeConfig(fetchImpl), maxBufferBytes: 80, minSessionDurationMs: 5_000, now: () => Date.now() },
        'sess-short-cap',
        'full',
        null,
        immediateCompression(),
        {},
        { takeFullSnapshot }
      )
      takeFullSnapshot.mockImplementation(() => {
        transport.add(refreshedSnapshot)
      })
      transport.start()
      transport.add(fullSnapshot)
      await vi.advanceTimersByTimeAsync(180)
      transport.add(click)

      expect(calls).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(4_819)
      expect(calls).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toHaveLength(0)
      transport.add({ ...mutation, timestamp: 5_001 })
      await vi.waitFor(() => {
        expect(calls).toHaveLength(1)
      })
      expect(takeFullSnapshot).toHaveBeenCalledOnce()
      expect(decodeBody(calls[0]!.init.body).events).toEqual([fullSnapshot, refreshedSnapshot])
      await transport.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a failed minimum-duration snapshot refresh without losing the valid prefix', async () => {
    vi.useFakeTimers()
    try {
      const { calls, fetchImpl } = recordingFetch()
      const refreshedSnapshot = { ...fullSnapshot, timestamp: 5_001 }
      const takeFullSnapshot = vi.fn()
      const transport = new ReplayTransport(
        { ...makeConfig(fetchImpl), maxBufferBytes: 80, minSessionDurationMs: 5_000 },
        'sess-refresh-retry',
        'full',
        null,
        immediateCompression(),
        {},
        { takeFullSnapshot }
      )
      takeFullSnapshot
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => {
          transport.add(refreshedSnapshot)
        })

      transport.start()
      transport.add(fullSnapshot)
      transport.add(click)
      transport.add({ ...mutation, timestamp: 5_001 })

      expect(takeFullSnapshot).toHaveBeenCalledOnce()
      expect(calls).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(60_000)
      expect(takeFullSnapshot).toHaveBeenCalledOnce()

      transport.add({ ...mutation, timestamp: 5_002 })
      await vi.waitFor(() => {
        expect(calls).toHaveLength(1)
      })
      expect(takeFullSnapshot).toHaveBeenCalledTimes(2)
      expect(decodeBody(calls[0]!.init.body).events).toEqual([fullSnapshot, refreshedSnapshot])
      await transport.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })

  it('discards a buffer-limit replay stopped before the minimum session duration', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const { calls, fetchImpl } = recordingFetch()
      const transport = timedTransport(fetchImpl, 'sess-short-cap', {
        maxBufferBytes: 80,
        minSessionDurationMs: 5_000,
      })
      transport.start()
      transport.add(fullSnapshot)
      await vi.advanceTimersByTimeAsync(180)
      transport.add(click)

      await transport.shutdown()
      await vi.advanceTimersByTimeAsync(4_820)

      expect(calls).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('measures the minimum from a replacement full snapshot', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const transport = new ReplayTransport(
      { ...makeConfig(fetchImpl), minSessionDurationMs: 5_000 },
      'sess-replaced-anchor',
      'full',
      null,
      immediateCompression()
    )
    const replacementSnapshot = { ...fullSnapshot, timestamp: 4_000 }
    const tooEarly = { ...mutation, timestamp: 5_001 }
    const endOfMinimum = { ...mutation, timestamp: 9_000 }

    transport.start()
    transport.add(fullSnapshot)
    transport.add(replacementSnapshot)
    transport.add(tooEarly)
    await transport.flush()
    expect(calls).toHaveLength(0)

    transport.add(endOfMinimum)
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1)
    })
    expect(decodeBody(calls[0]!.init.body).events).toEqual([replacementSnapshot, tooEarly, endOfMinimum])
    await transport.shutdown()
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

  it('backs off background uploads while idle and resumes quickly on user activity', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const { calls, fetchImpl } = recordingFetch()
      const transport = timedTransport(fetchImpl, 'sess-adaptive')
      transport.start()
      transport.add(fullSnapshot)
      await vi.advanceTimersByTimeAsync(5_000)
      await vi.waitFor(() => {
        expect(calls).toHaveLength(1)
      })

      vi.setSystemTime(31_000)
      transport.add(mutation)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(calls).toHaveLength(1)

      transport.add(click)
      await vi.advanceTimersByTimeAsync(4_999)
      expect(calls).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      await vi.waitFor(() => {
        expect(calls).toHaveLength(2)
      })
      expect(decodeBody(calls[1]!.init.body).events).toEqual([mutation, click])

      vi.setSystemTime(72_000)
      transport.add(mutation)
      await vi.advanceTimersByTimeAsync(59_999)
      expect(calls).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(1)
      await vi.waitFor(() => {
        expect(calls).toHaveLength(3)
      })
      expect(decodeBody(calls[2]!.init.body).events).toEqual([mutation])
      await transport.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses a five-minute cadence after five minutes without activity', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const { calls, fetchImpl } = recordingFetch()
      const transport = timedTransport(fetchImpl, 'sess-deep-idle')
      transport.start()

      vi.setSystemTime(5 * 60_000)
      transport.add(mutation)
      await vi.advanceTimersByTimeAsync(5 * 60_000 - 1)
      expect(calls).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(1)
      await vi.waitFor(() => {
        expect(calls).toHaveLength(1)
      })
      expect(decodeBody(calls[0]!.init.body).events).toEqual([mutation])
      await transport.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not postpone a deep-idle upload when more background events arrive', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const { calls, fetchImpl } = recordingFetch()
      const transport = timedTransport(fetchImpl, 'sess-deep-idle-deadline')
      transport.start()

      vi.setSystemTime(5 * 60_000)
      transport.add(mutation)
      await vi.advanceTimersByTimeAsync(4 * 60_000)
      const laterMutation = { ...mutation, timestamp: 4 }
      transport.add(laterMutation)

      await vi.advanceTimersByTimeAsync(60_000 - 1)
      expect(calls).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1)
      await vi.waitFor(() => {
        expect(calls).toHaveLength(1)
      })
      expect(decodeBody(calls[0]!.init.body).events).toEqual([mutation, laterMutation])
      await transport.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores the active cadence when activity resumes during deep idle', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const { calls, fetchImpl } = recordingFetch()
      const transport = timedTransport(fetchImpl, 'sess-deep-idle-activity')
      transport.start()

      vi.setSystemTime(5 * 60_000)
      transport.add(mutation)
      await vi.advanceTimersByTimeAsync(60_000)
      transport.add(click)

      await vi.advanceTimersByTimeAsync(4_999)
      expect(calls).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1)
      await vi.waitFor(() => {
        expect(calls).toHaveLength(1)
      })
      expect(decodeBody(calls[0]!.init.body).events).toEqual([mutation, click])
      await transport.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes at the buffer limit during deep idle without a later timer upload', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const { calls, fetchImpl } = recordingFetch()
      const maxBufferBytes = strToU8(JSON.stringify(fullSnapshot)).byteLength + strToU8(JSON.stringify(mutation)).byteLength
      const transport = timedTransport(fetchImpl, 'sess-deep-idle-cap', { maxBufferBytes })
      transport.start()

      vi.setSystemTime(5 * 60_000)
      transport.add(fullSnapshot)
      transport.add(mutation)
      await vi.waitFor(() => {
        expect(calls).toHaveLength(1)
      })
      expect(decodeBody(calls[0]!.init.body).events).toEqual([fullSnapshot, mutation])

      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(calls).toHaveLength(1)
      await transport.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not shorten a configured flush interval while idle', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(31_000)
      const { calls, fetchImpl } = recordingFetch()
      const transport = timedTransport(fetchImpl, 'sess-slow-cadence', { flushIntervalMs: 90_000 })
      transport.start()
      vi.setSystemTime(62_000)
      transport.add(mutation)

      await vi.advanceTimersByTimeAsync(89_999)
      expect(calls).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1)
      await vi.waitFor(() => {
        expect(calls).toHaveLength(1)
      })
      expect(decodeBody(calls[0]!.init.body).events).toEqual([mutation])
      await transport.shutdown()
    } finally {
      vi.useRealTimers()
    }
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

  it('aborts a stalled lifecycle upload and releases flush completion', async () => {
    vi.useFakeTimers()
    try {
      let uploadSignal: AbortSignal | undefined
      const fetchImpl = vi.fn(
        async (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            uploadSignal = init?.signal ?? undefined
            uploadSignal?.addEventListener(
              'abort',
              () => {
                const reason: unknown = uploadSignal?.reason
                reject(reason instanceof Error ? reason : new Error('replay upload aborted'))
              },
              { once: true }
            )
          })
      ) as unknown as typeof fetch
      const onError = vi.fn()
      const transport = new ReplayTransport({ ...makeConfig(fetchImpl), onError }, 'sess-timeout', 'full', null)
      transport.add(fullSnapshot)

      const flush = transport.flush({ keepalive: true })
      await vi.advanceTimersByTimeAsync(REPLAY_UPLOAD_TIMEOUT_MS)
      await flush

      expect(uploadSignal?.aborted).toBe(true)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(onError).toHaveBeenCalledOnce()
      const reported = onError.mock.calls[0]?.[0] as ReplayUploadError
      expect(reported).toBeInstanceOf(ReplayUploadError)
      expect(reported).toMatchObject({ reason: 'unconfirmed', seq: 0 })
      expect((reported.cause as Error).message).toBe('replay upload timed out after 10000ms')
    } finally {
      vi.useRealTimers()
    }
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
    const sessionAttributes = { account_tier: 'pro', beta_user: true }
    const transport = new ReplayTransport(makeConfig(fetchImpl), 'sess-large', 'full', null, undefined, sessionAttributes)
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
    expect(calls.map((call) => decodeBody(call.init.body).meta.sessionAttributes)).toEqual([
      sessionAttributes,
      sessionAttributes,
      sessionAttributes,
    ])
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
    // The lost first chunk requires a new anchor before later events upload.
    transport.add(fullSnapshot)
    transport.add(largeEvent(20, 2))
    await transport.flush({ keepalive: true })
    expect(keepaliveFlags).toHaveLength(failure === 'network' ? 2 : 1)
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
      const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => {
        attempts += 1
        return attempts === 1
          ? new Response(null, header === null ? { status: 429 } : { status: 429, headers: { 'retry-after': header } })
          : new Response(null, { status: 202 })
      })
      const fetchImpl = fetchMock as unknown as typeof fetch
      const sessionAttributes = { account_tier: 'pro' }
      const transport = new ReplayTransport(
        makeConfig(fetchImpl),
        'sess-retry-after',
        'full',
        null,
        immediateCompression(),
        sessionAttributes
      )
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
      expect(fetchMock.mock.calls.map((call) => decodeBody(call[1]?.body).meta.sessionAttributes)).toEqual([
        sessionAttributes,
        sessionAttributes,
      ])
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

  it('honors Retry-After beyond ten seconds while it fits the retry budget', async () => {
    await expectRetryAfter('11', 11_000)
  })

  it('does not retry early when Retry-After exceeds the remaining retry budget', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn(async () => new Response(null, { status: 429, headers: { 'retry-after': '31' } })) as unknown as typeof fetch
      const onError = vi.fn()
      const transport = new ReplayTransport({ ...makeConfig(fetchImpl), onError }, 'sess-long', 'full', null, immediateCompression())
      transport.add(fullSnapshot)
      await transport.flush()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: 'unconfirmed', seq: 0, status: 429 }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('backs off exponentially, exhausts the 30s budget, and refreshes credentials', async () => {
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
      // Attempts at 0, 0.5, 1.5, 3.5, 7.5, 15.5 and 23.5 seconds; the next 8s wait would pass 30s.
      const attemptTimes = [500, 1_500, 3_500, 7_500, 15_500, 23_500]
      let elapsed = 0
      for (const [index, attemptTime] of attemptTimes.entries()) {
        // eslint-disable-next-line no-await-in-loop -- each step checks the schedule before the next attempt.
        await vi.advanceTimersByTimeAsync(attemptTime - elapsed - 1)
        expect(fetchImpl).toHaveBeenCalledTimes(index + 1)
        // eslint-disable-next-line no-await-in-loop -- each step checks the schedule before the next attempt.
        await vi.advanceTimersByTimeAsync(1)
        expect(fetchImpl).toHaveBeenCalledTimes(index + 2)
        elapsed = attemptTime
      }
      await flush

      expect(fetchImpl).toHaveBeenCalledTimes(7)
      expect(token).toHaveBeenCalledTimes(7)
      expect(headers).toHaveBeenCalledTimes(7)
      expect(urls).toEqual(Array(7).fill('https://app.example.com/replay-proxy/sess-exhausted?seq=0'))
      expect(bodies.map((body) => Array.from(body))).toEqual(Array(7).fill(Array.from(bodies[0]!)))
      expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: 'unconfirmed', seq: 0, status: 429 }))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ReplayTransport buffer mode', () => {
  it('preserves observed session duration across periodic checkout snapshots', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const transport = new ReplayTransport(
      { ...makeConfig(fetchImpl), minSessionDurationMs: 180_000 },
      'sess-long-minimum',
      'buffer',
      null,
      immediateCompression()
    )
    const checkoutSnapshot = { ...fullSnapshot, timestamp: 120_001 }
    const qualifyingEvent = { ...mutation, timestamp: 180_001 }

    transport.add(fullSnapshot)
    transport.add(checkoutSnapshot)
    transport.add(qualifyingEvent)
    expect(calls).toHaveLength(0)

    await transport.triggerFlush()

    expect(calls).toHaveLength(1)
    expect(decodeBody(calls[0]!.init.body).events).toEqual([checkoutSnapshot, qualifyingEvent])
    await transport.shutdown()
  })

  it('waits until the minimum session duration after error promotion', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const { calls, fetchImpl } = recordingFetch()
      const transport = new ReplayTransport(
        {
          ...makeConfig(fetchImpl),
          minSessionDurationMs: 5_000,
          now: () => Date.now(),
        },
        'sess-short-error',
        'buffer',
        null,
        immediateCompression()
      )
      transport.add(fullSnapshot)
      await vi.advanceTimersByTimeAsync(1_000)

      await transport.triggerFlush()
      await vi.advanceTimersByTimeAsync(3_999)
      expect(calls).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toHaveLength(0)
      const endOfMinimum = { ...mutation, timestamp: 5_001 }
      transport.add(endOfMinimum)
      await vi.waitFor(() => {
        expect(calls).toHaveLength(1)
      })
      expect(decodeBody(calls[0]!.init.body).events).toEqual([fullSnapshot, endOfMinimum])
      await transport.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-anchors a capped error buffer when it is promoted', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const refreshedSnapshot = { ...fullSnapshot, timestamp: 5_001 }
    const takeFullSnapshot = vi.fn()
    const transport = new ReplayTransport(
      { ...makeConfig(fetchImpl), maxBufferBytes: 80, minSessionDurationMs: 5_000 },
      'sess-capped-error',
      'buffer',
      null,
      immediateCompression(),
      {},
      { takeFullSnapshot }
    )
    takeFullSnapshot.mockImplementation(() => {
      transport.add(refreshedSnapshot)
    })

    transport.add(fullSnapshot)
    transport.add(click)
    transport.add({ ...mutation, timestamp: 5_001 })
    await transport.triggerFlush()

    expect(takeFullSnapshot).toHaveBeenCalledOnce()
    expect(calls).toHaveLength(1)
    expect(decodeBody(calls[0]!.init.body).events).toEqual([fullSnapshot, refreshedSnapshot])
    await transport.shutdown()
  })

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
    const latestMeta = {
      ...meta,
      data: { href: 'https://app.example.com/latest', height: 720, width: 1_280 },
      timestamp: 9,
    }
    transport.add(meta)
    transport.add(fullSnapshot)
    transport.add(click)
    transport.add(latestMeta)
    transport.add({ ...fullSnapshot, timestamp: 10 })
    await transport.triggerFlush()
    const envelope = decodeBody(calls[0]!.init.body)
    expect(envelope.events.map((event) => event.timestamp)).toEqual([9, 10])
    expect(envelope.meta.urls).toEqual(['https://app.example.com/latest'])
  })

  it('keeps the earliest contiguous incrementals within the buffer cap', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const firstIncremental = { ...click, timestamp: 2 }
    const secondIncremental = { ...click, timestamp: 3 }
    const maxBufferBytes = strToU8(JSON.stringify(fullSnapshot)).byteLength + strToU8(JSON.stringify(firstIncremental)).byteLength
    const transport = new ReplayTransport({ ...makeConfig(fetchImpl), maxBufferBytes }, 'sess-cap-buffer', 'buffer', null)
    transport.add(click)
    transport.add(fullSnapshot)
    transport.add(firstIncremental)
    transport.add(secondIncremental)

    await transport.triggerFlush()

    expect(decodeBody(calls[0]!.init.body).events.map((event) => event.timestamp)).toEqual([1, 2])
  })

  it('drops incremental events that exceed the cap and retains an oversized anchor alone', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const oversizedIncremental = { ...click, timestamp: 4, data: { text: 'x'.repeat(100) } }
    const transport = new ReplayTransport({ ...makeConfig(fetchImpl), maxBufferBytes: 10 }, 'sess-oversized', 'buffer', null)
    transport.add(oversizedIncremental)
    transport.add(fullSnapshot)
    transport.add(oversizedIncremental)
    await transport.triggerFlush()

    expect(decodeBody(calls[0]!.init.body).events.map((event) => event.timestamp)).toEqual([1])
  })
})

describe('ReplayTransport sequence persistence', () => {
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

describe('ReplayTransport upload recovery', () => {
  const anchorMeta: RrwebEvent = { ...meta, timestamp: 100 }
  const anchorSnapshot: RrwebEvent = { ...fullSnapshot, timestamp: 101 }

  function scriptedFetch(respond: (seq: number, attempt: number) => Response | Promise<Response>) {
    const calls: { seq: number; body: Uint8Array }[] = []
    const attempts = new Map<number, number>()
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const seq = Number(new URL(String(url)).searchParams.get('seq'))
      const attempt = (attempts.get(seq) ?? 0) + 1
      attempts.set(seq, attempt)
      calls.push({ seq, body: init?.body as Uint8Array })
      return respond(seq, attempt)
    }) as unknown as typeof fetch
    return { calls, fetchImpl }
  }

  function accepted(): Response {
    return new Response(null, { status: 202 })
  }

  function recoveringTransport(
    fetchImpl: typeof fetch,
    overrides: Partial<ResolvedSessionReplayConfig> = {},
    compression = immediateCompression()
  ) {
    const onError = vi.fn()
    const holder: { transport?: ReplayTransport } = {}
    const takeFullSnapshot = vi.fn(() => {
      holder.transport!.add(anchorMeta)
      holder.transport!.add(anchorSnapshot)
    })
    const transport = new ReplayTransport(
      { ...makeConfig(fetchImpl), now: () => Date.now(), onError, ...overrides },
      'sess-recover',
      'full',
      null,
      compression,
      {},
      { takeFullSnapshot }
    )
    holder.transport = transport
    return { onError, takeFullSnapshot, transport }
  }

  function timestamps(body: Uint8Array): number[] {
    return decodeBody(body as BodyInit).events.map((event) => event.timestamp)
  }

  it('reports an exhausted chunk and re-anchors before later events upload', async () => {
    vi.useFakeTimers()
    try {
      const { calls, fetchImpl } = scriptedFetch((seq) => {
        if (seq === 1) {
          throw new TypeError('Failed to fetch')
        }
        return accepted()
      })
      const { onError, takeFullSnapshot, transport } = recoveringTransport(fetchImpl)
      transport.add(fullSnapshot)
      await transport.flush()
      transport.add(mutation)
      const lost = transport.flush()
      await vi.advanceTimersByTimeAsync(10_000)
      // Recorded while seq=1 is still retrying, so it depends on the lost chunk.
      transport.add({ ...mutation, timestamp: 50 })
      await vi.advanceTimersByTimeAsync(20_000)
      await lost

      expect(onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ droppedSeqs: [], name: 'ReplayUploadError', reason: 'unconfirmed', seq: 1, sessionId: 'sess-recover' })
      )
      expect(takeFullSnapshot).toHaveBeenCalledTimes(1)
      transport.add({ ...click, timestamp: 102 })
      await transport.flush()

      const delivered = calls.filter((call) => call.seq !== 1)
      expect(delivered.map((call) => call.seq)).toEqual([0, 2])
      expect(timestamps(delivered[1]!.body)).toEqual([100, 101, 102])
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a lost acknowledgement with the same seq and bytes', async () => {
    vi.useFakeTimers()
    try {
      const { calls, fetchImpl } = scriptedFetch((_seq, attempt) => {
        if (attempt === 1) {
          throw new TypeError('Failed to fetch')
        }
        return accepted()
      })
      const { onError, takeFullSnapshot, transport } = recoveringTransport(fetchImpl)
      transport.add(fullSnapshot)
      const flush = transport.flush()
      await vi.advanceTimersByTimeAsync(500)
      await flush
      await vi.advanceTimersByTimeAsync(0)

      expect(calls.map((call) => call.seq)).toEqual([0, 0])
      expect(Array.from(calls[1]!.body)).toEqual(Array.from(calls[0]!.body))
      expect(onError).not.toHaveBeenCalled()
      expect(takeFullSnapshot).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([408, 425, 429, 500, 502, 503])('retries status %i', async (status) => {
    vi.useFakeTimers()
    try {
      const { calls, fetchImpl } = scriptedFetch((_seq, attempt) => (attempt === 1 ? new Response(null, { status }) : accepted()))
      const { onError, transport } = recoveringTransport(fetchImpl)
      transport.add(fullSnapshot)
      const flush = transport.flush()
      await vi.advanceTimersByTimeAsync(499)
      expect(calls).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      await flush

      expect(calls).toHaveLength(2)
      expect(onError).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('honors Retry-After on 503', async () => {
    vi.useFakeTimers()
    try {
      const { calls, fetchImpl } = scriptedFetch((_seq, attempt) =>
        attempt === 1 ? new Response(null, { status: 503, headers: { 'retry-after': '2' } }) : accepted()
      )
      const { transport } = recoveringTransport(fetchImpl)
      transport.add(fullSnapshot)
      const flush = transport.flush()
      await vi.advanceTimersByTimeAsync(1_999)
      expect(calls).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      await flush
      expect(calls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([400, 401, 403, 404, 413, 422])('does not retry terminal status %i and re-anchors', async (status) => {
    vi.useFakeTimers()
    try {
      const { calls, fetchImpl } = scriptedFetch(() => new Response(null, { status }))
      const { onError, takeFullSnapshot, transport } = recoveringTransport(fetchImpl)
      transport.add(fullSnapshot)
      await transport.flush()
      await vi.advanceTimersByTimeAsync(0)

      expect(calls).toHaveLength(1)
      expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: 'rejected', seq: 0, status }))
      expect(takeFullSnapshot).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries header failures before the request and keeps the seq', async () => {
    vi.useFakeTimers()
    try {
      const { calls, fetchImpl } = scriptedFetch(() => accepted())
      let headerCalls = 0
      const headers = vi.fn(async () => {
        headerCalls += 1
        if (headerCalls <= 2) {
          throw new Error('credentials unavailable')
        }
        return {}
      })
      const { onError, transport } = recoveringTransport(fetchImpl, { headers })
      transport.add(fullSnapshot)
      const flush = transport.flush()
      await vi.advanceTimersByTimeAsync(1_500)
      await flush

      expect(calls.map((call) => call.seq)).toEqual([0])
      expect(onError).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    [
      'rejecting headers',
      {
        headers: async () => {
          throw new Error('headers unavailable')
        },
      },
    ],
    [
      'throwing headers',
      {
        headers: () => {
          throw new Error('headers unavailable')
        },
      },
    ],
    [
      'rejecting token',
      {
        token: async () => {
          throw new Error('token unavailable')
        },
      },
    ],
  ] as const)('reports %s that never recover as not-sent', async (_name, overrides) => {
    vi.useFakeTimers()
    try {
      const { calls, fetchImpl } = scriptedFetch(() => accepted())
      const { onError, takeFullSnapshot, transport } = recoveringTransport(fetchImpl, overrides)
      transport.add(fullSnapshot)
      const flush = transport.flush()
      await vi.advanceTimersByTimeAsync(30_000)
      await flush
      await vi.advanceTimersByTimeAsync(0)

      expect(calls).toHaveLength(0)
      expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: 'not-sent', seq: 0 }))
      expect(takeFullSnapshot).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('delivers queued chunks in order with their original bytes after an outage', async () => {
    vi.useFakeTimers()
    try {
      const outageEnd = Date.now() + 20_000
      const { calls, fetchImpl } = scriptedFetch(() => {
        if (Date.now() < outageEnd) {
          throw new TypeError('Failed to fetch')
        }
        return accepted()
      })
      const { onError, takeFullSnapshot, transport } = recoveringTransport(fetchImpl)
      transport.add(fullSnapshot)
      const first = transport.flush()
      await vi.advanceTimersByTimeAsync(5_000)
      transport.add(click)
      const second = transport.flush()
      await vi.advanceTimersByTimeAsync(5_000)
      transport.add(mutation)
      const third = transport.flush()
      await vi.advanceTimersByTimeAsync(20_000)
      await Promise.all([first, second, third])

      expect(onError).not.toHaveBeenCalled()
      expect(takeFullSnapshot).not.toHaveBeenCalled()
      expect(calls.slice(-3).map((call) => call.seq)).toEqual([0, 1, 2])
      const firstBodies = calls.filter((call) => call.seq === 0).map((call) => Array.from(call.body))
      expect(firstBodies.length).toBeGreaterThan(1)
      expect(new Set(firstBodies.map((body) => body.join(','))).size).toBe(1)
      expect(calls.slice(-3).map((call) => timestamps(call.body))).toEqual([[1], [2], [3]])
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['hung upload', 'stalled compressor'] as const)(
    'rejects a batch that would overflow the queue during a %s and keeps queued chunks',
    async (stall) => {
      vi.useFakeTimers()
      try {
        let release: () => void = () => undefined
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        const { calls, fetchImpl } = scriptedFetch(async () => {
          if (stall === 'hung upload') {
            await gate
          }
          return accepted()
        })
        const compression = {
          gzip: ((input: Uint8Array, _options: unknown, callback: (error: Error | null, data: Uint8Array) => void) => {
            gate.then(
              () => {
                callback(null, gzipSync(input))
              },
              () => undefined
            )
          }) as typeof gzip,
          gzipSync,
        }
        const { onError, takeFullSnapshot, transport } = recoveringTransport(
          fetchImpl,
          { maxBufferBytes: 1_000_000 },
          stall === 'stalled compressor' ? compression : immediateCompression()
        )
        transport.add(fullSnapshot)
        transport.add(largeEvent(10, 1, 700_000))
        const first = transport.flush()
        transport.add(largeEvent(20, 2, 700_000))
        const second = transport.flush()
        transport.add(largeEvent(30, 3, 700_000))
        const rejected = transport.flush()
        await rejected

        expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ droppedSeqs: [], reason: 'not-sent', seq: undefined }))
        await vi.advanceTimersByTimeAsync(0)
        expect(takeFullSnapshot).toHaveBeenCalledTimes(1)

        release()
        await Promise.all([first, second])
        await transport.flush()

        expect(calls.map((call) => call.seq)).toEqual([0, 1, 2])
        expect(calls.map((call) => timestamps(call.body))).toEqual([[1, 10], [20], [100, 101]])
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('admits a second full batch while a large-buffer upload is in flight', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { calls, fetchImpl } = scriptedFetch(async () => {
      await gate
      return accepted()
    })
    const { onError, transport } = recoveringTransport(fetchImpl, { maxBufferBytes: 4_000_000 })
    transport.add(fullSnapshot)
    transport.add(largeEvent(10, 1, 2_500_000))
    const first = transport.flush()
    transport.add(largeEvent(20, 2, 2_500_000))
    const second = transport.flush()
    release()
    await Promise.all([first, second])

    expect(onError).not.toHaveBeenCalled()
    expect(calls.map((call) => call.seq)).toEqual([0, 1])
  })

  it('keeps flush order when compression callbacks finish in reverse order', async () => {
    vi.useFakeTimers()
    try {
      const { calls, fetchImpl } = scriptedFetch(() => accepted())
      let compressions = 0
      const compression = {
        gzip: ((input: Uint8Array, _options: unknown, callback: (error: Error | null, data: Uint8Array) => void) => {
          compressions += 1
          setTimeout(
            () => {
              callback(null, gzipSync(input))
            },
            compressions === 1 ? 300 : 1
          )
        }) as typeof gzip,
        gzipSync,
      }
      const { transport } = recoveringTransport(fetchImpl, {}, compression)
      transport.add(fullSnapshot)
      const first = transport.flush()
      transport.add(click)
      const second = transport.flush()
      transport.add(mutation)
      const third = transport.flush()
      await vi.advanceTimersByTimeAsync(1_000)
      await Promise.all([first, second, third])

      expect(calls.map((call) => call.seq)).toEqual([0, 1, 2])
      expect(calls.map((call) => timestamps(call.body))).toEqual([[1], [2], [3]])
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops only dependent chunks after a lost chunk and keeps the next anchor', async () => {
    vi.useFakeTimers()
    try {
      const { calls, fetchImpl } = scriptedFetch((seq) => {
        if (seq === 0) {
          throw new TypeError('Failed to fetch')
        }
        return accepted()
      })
      const { onError, takeFullSnapshot, transport } = recoveringTransport(fetchImpl)
      transport.add(fullSnapshot)
      const first = transport.flush()
      transport.add(mutation)
      const dependent = transport.flush()
      transport.add({ ...meta, timestamp: 40 })
      transport.add({ ...fullSnapshot, timestamp: 41 })
      const anchor = transport.flush()
      transport.add({ ...click, timestamp: 42 })
      const afterAnchor = transport.flush()
      transport.add({ ...mutation, timestamp: 43 })
      await vi.advanceTimersByTimeAsync(30_000)
      await Promise.all([first, dependent, anchor, afterAnchor])
      await vi.advanceTimersByTimeAsync(0)
      await transport.flush()

      expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ droppedSeqs: [1], reason: 'unconfirmed', seq: 0 }))
      expect(takeFullSnapshot).not.toHaveBeenCalled()
      const delivered = calls.filter((call) => call.seq !== 0)
      expect(delivered.map((call) => call.seq)).toEqual([2, 3, 4])
      expect(delivered.map((call) => timestamps(call.body))).toEqual([[40, 41], [42], [43]])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a buffered anchor instead of taking a new snapshot', async () => {
    vi.useFakeTimers()
    try {
      const { calls, fetchImpl } = scriptedFetch((seq) => (seq === 0 ? new Response(null, { status: 400 }) : accepted()))
      const { onError, takeFullSnapshot, transport } = recoveringTransport(fetchImpl)
      transport.add(fullSnapshot)
      const lost = transport.flush()
      transport.add(click)
      transport.add({ ...meta, timestamp: 40 })
      transport.add({ ...fullSnapshot, timestamp: 41 })
      transport.add({ ...mutation, timestamp: 42 })
      await lost
      await vi.advanceTimersByTimeAsync(0)
      await transport.flush()

      expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: 'rejected', seq: 0 }))
      expect(takeFullSnapshot).not.toHaveBeenCalled()
      expect(calls.filter((call) => call.seq === 1).map((call) => timestamps(call.body))).toEqual([[40, 41, 42]])
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes at most one resync snapshot per minute', async () => {
    vi.useFakeTimers()
    try {
      const { fetchImpl } = scriptedFetch(() => new Response(null, { status: 401 }))
      const takeFullSnapshot = vi.fn()
      const onError = vi.fn()
      const transport = new ReplayTransport(
        { ...makeConfig(fetchImpl), now: () => Date.now(), onError },
        'sess-rate',
        'full',
        null,
        immediateCompression(),
        {},
        { takeFullSnapshot }
      )
      transport.add(fullSnapshot)
      await transport.flush()
      await vi.advanceTimersByTimeAsync(0)
      expect(takeFullSnapshot).toHaveBeenCalledTimes(1)
      expect(onError).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'replay resync snapshot produced no full snapshot' }))

      await vi.advanceTimersByTimeAsync(59_999)
      expect(takeFullSnapshot).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(takeFullSnapshot).toHaveBeenCalledTimes(2)
      transport.discard()
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-anchors after a lost lifecycle chunk when recording continues', async () => {
    vi.useFakeTimers()
    try {
      const { calls, fetchImpl } = scriptedFetch((seq) => {
        if (seq === 0) {
          throw new TypeError('Failed to fetch')
        }
        return accepted()
      })
      const { onError, takeFullSnapshot, transport } = recoveringTransport(fetchImpl)
      transport.add(fullSnapshot)
      await transport.flush({ keepalive: true })
      transport.add(click)
      await vi.advanceTimersByTimeAsync(0)
      await transport.flush()

      expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: 'unconfirmed', seq: 0 }))
      expect(takeFullSnapshot).toHaveBeenCalledTimes(1)
      expect(calls.map((call) => call.seq)).toEqual([0, 1])
      expect(timestamps(calls[1]!.body)).toEqual([100, 101])
    } finally {
      vi.useRealTimers()
    }
  })
})
