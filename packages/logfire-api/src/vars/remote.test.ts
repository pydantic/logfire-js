import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { LogfireRemoteVariableProvider } from '.'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input
  }
  if (input instanceof URL) {
    return input.toString()
  }
  return input.url
}

function makeVariablesConfig(overrides: Record<string, unknown> = {}): unknown {
  return { variables: overrides }
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('LogfireRemoteVariableProvider -- SSE and polling reliability', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // 1. Reconnect triggers refresh; first connect does not
  // -------------------------------------------------------------------------
  it('triggers refresh on SSE reconnect but not on the initial connection', async () => {
    const urls: string[] = []
    let sseCallCount = 0

    const fetchImpl = vi.fn<typeof fetch>(async (input, _init) => {
      await Promise.resolve()
      const url = requestUrl(input)
      urls.push(url)

      if (url.includes('/v1/variable-updates/')) {
        sseCallCount++
        if (sseCallCount <= 2) {
          // First and second SSE calls: stream that immediately closes
          return new Response(makeStream([]), { status: 200 })
        }
        // Third+ calls: block indefinitely so the loop stays paused
        return new Promise<Response>(() => {
          // Never resolves; provider.shutdown() will abort the signal
        })
      }

      // /v1/variables/ responses
      return new Response(JSON.stringify(makeVariablesConfig()), { status: 200 })
    })

    const provider = new LogfireRemoteVariableProvider({
      apiKey: 'test-key',
      baseUrl: 'https://example.com',
      fetch: fetchImpl,
      polling: false,
      sse: true,
    })

    provider.start()

    // Let the first SSE connection complete (stream immediately done).
    await vi.advanceTimersByTimeAsync(0)

    const varFetchesAfterFirstConnect = urls.filter((u) => u.includes('/v1/variables/')).length
    // First connection must NOT trigger a variables fetch.
    expect(varFetchesAfterFirstConnect).toBe(0)

    // Advance past the 1000ms reconnect delay so the second connection fires.
    await vi.advanceTimersByTimeAsync(1100)

    const varFetchesAfterReconnect = urls.filter((u) => u.includes('/v1/variables/')).length
    // Second connection (reconnect) MUST trigger exactly one variables fetch.
    expect(varFetchesAfterReconnect).toBe(1)

    provider.shutdown()
  })

  // -------------------------------------------------------------------------
  // 2. Keepalive lines reset the reconnect backoff
  // -------------------------------------------------------------------------
  it('resets the reconnect delay after a keepalive-only stream', async () => {
    let sseCallCount = 0

    const fetchImpl = vi.fn<typeof fetch>(async (input, _init) => {
      await Promise.resolve()
      const url = requestUrl(input)

      if (url.includes('/v1/variable-updates/')) {
        sseCallCount++

        if (sseCallCount === 1) {
          // First connection: empty stream -> no content -> delay stays at 1000ms, then doubles
          return new Response(makeStream([]), { status: 200 })
        }
        if (sseCallCount === 2) {
          // Second connection: keepalive comment only -> receivedAnyContent = true -> delay resets to 1000ms
          return new Response(makeStream([': keepalive\n\n']), { status: 200 })
        }
        // Third+ connections: block to prevent further progress
        return new Promise<Response>(() => {
          // Never resolves
        })
      }

      return new Response(JSON.stringify(makeVariablesConfig()), { status: 200 })
    })

    const provider = new LogfireRemoteVariableProvider({
      apiKey: 'test-key',
      baseUrl: 'https://example.com',
      fetch: fetchImpl,
      polling: false,
      sse: true,
    })

    provider.start()

    // Let the first SSE connection complete (empty stream, ~immediately).
    await vi.advanceTimersByTimeAsync(0)
    expect(sseCallCount).toBe(1)

    // After the first empty stream: delay is 1000ms before reconnect, then doubles to 2000ms.
    // Advance 1100ms to trigger the second connection.
    await vi.advanceTimersByTimeAsync(1100)
    expect(sseCallCount).toBe(2)

    // The second connection had a keepalive, so receivedAnyContent=true -> delay resets to 1000ms.
    // Advance 1100ms (enough for 1000ms delay but NOT enough for 2000ms delay).
    await vi.advanceTimersByTimeAsync(1100)
    // If the delay reset to 1000ms, the third connection fires within 1100ms.
    // If the delay had NOT been reset (stayed at 2000ms), the third connection would not fire yet.
    expect(sseCallCount).toBe(3)

    provider.shutdown()
  })

  // -------------------------------------------------------------------------
  // 3. 304 keeps config unchanged and updates lastFetchedAt
  // -------------------------------------------------------------------------
  it('handles 304 Not Modified by keeping the current config and bumping lastFetchedAt', async () => {
    const initialConfig = makeVariablesConfig({
      my_flag: { labels: { on: { serialized_value: 'true', version: 1 } }, name: 'my_flag', overrides: [], rollout: { labels: { on: 1 } } },
    })
    let callCount = 0

    const fetchImpl = vi.fn<typeof fetch>(async (_input, _init) => {
      await Promise.resolve()
      callCount++
      if (callCount === 1) {
        // First call: return config with an ETag
        return new Response(JSON.stringify(initialConfig), {
          headers: { ETag: '"v1"' },
          status: 200,
        })
      }
      // Subsequent calls: 304 Not Modified
      return new Response(null, { status: 304 })
    })

    const provider = new LogfireRemoteVariableProvider({
      apiKey: 'test-key',
      baseUrl: 'https://example.com',
      fetch: fetchImpl,
      polling: false,
      sse: false,
    })

    // First refresh: loads config
    await provider.refresh(true)
    expect(callCount).toBe(1)

    // Config should be populated
    const valueBefore = provider.getVariableConfig('my_flag')
    expect(valueBefore).toBeDefined()

    // Second refresh (forced, so bypasses the interval check): gets 304
    await provider.refresh(true)
    expect(callCount).toBe(2)

    // Config must be unchanged after 304
    const valueAfter = provider.getVariableConfig('my_flag')
    expect(valueAfter).toEqual(valueBefore)

    // Verify lastFetchedAt was updated: a non-forced refresh right after should NOT fetch again.
    // (The pollingInterval is 60s by default; lastFetchedAt was just bumped by the 304.)
    await provider.refresh(false)
    expect(callCount).toBe(2) // No additional fetch; interval not expired
  })

  // -------------------------------------------------------------------------
  // 4. If-None-Match is sent when an ETag is known
  // -------------------------------------------------------------------------
  it('sends If-None-Match on subsequent fetches after receiving an ETag', async () => {
    interface RequestRecord {
      ifNoneMatch: string | null
    }
    const requestHeaders: RequestRecord[] = []

    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      await Promise.resolve()
      const headers = new Headers(init?.headers)
      requestHeaders.push({
        ifNoneMatch: headers.get('if-none-match'),
      })
      return new Response(JSON.stringify(makeVariablesConfig()), {
        headers: { ETag: '"abc123"' },
        status: 200,
      })
    })

    const provider = new LogfireRemoteVariableProvider({
      apiKey: 'test-key',
      baseUrl: 'https://example.com',
      fetch: fetchImpl,
      polling: false,
      sse: false,
    })

    // First refresh: no ETag known yet
    await provider.refresh(true)
    expect(requestHeaders[0]?.ifNoneMatch).toBeNull()

    // Second refresh: ETag from first response should be sent
    await provider.refresh(true)
    expect(requestHeaders[1]?.ifNoneMatch).toBe('"abc123"')
  })

  // -------------------------------------------------------------------------
  // 5. Jittered scheduling stays within the ±10% bounds
  // -------------------------------------------------------------------------
  it('schedules polls at pollingInterval - 10% when Math.random returns 0', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0) // Minimum jitter: -10%
    const pollingInterval = 60 // seconds
    const expectedDelayMs = pollingInterval * 1000 * 0.9 // 54000ms

    const fetchImpl = vi.fn<typeof fetch>(async () => {
      await Promise.resolve()
      return new Response(JSON.stringify(makeVariablesConfig()), { status: 200 })
    })

    const provider = new LogfireRemoteVariableProvider({
      apiKey: 'test-key',
      baseUrl: 'https://example.com',
      fetch: fetchImpl,
      polling: true,
      pollingInterval,
      sse: false,
    })

    provider.start()

    // Just before the expected delay: no fetch yet
    await vi.advanceTimersByTimeAsync(expectedDelayMs - 1)
    expect(fetchImpl).not.toHaveBeenCalled()

    // At the expected delay: fetch fires
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    provider.shutdown()
  })

  it('schedules polls at pollingInterval + 10% when Math.random returns 1', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1) // Maximum jitter: +10%
    const pollingInterval = 60 // seconds
    const expectedDelayMs = pollingInterval * 1000 * 1.1 // 66000ms

    const fetchImpl = vi.fn<typeof fetch>(async () => {
      await Promise.resolve()
      return new Response(JSON.stringify(makeVariablesConfig()), { status: 200 })
    })

    const provider = new LogfireRemoteVariableProvider({
      apiKey: 'test-key',
      baseUrl: 'https://example.com',
      fetch: fetchImpl,
      polling: true,
      pollingInterval,
      sse: false,
    })

    provider.start()

    // Just before the expected delay: no fetch yet
    await vi.advanceTimersByTimeAsync(expectedDelayMs - 1)
    expect(fetchImpl).not.toHaveBeenCalled()

    // At the expected delay: fetch fires
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    provider.shutdown()
  })

  // -------------------------------------------------------------------------
  // 6. Shutdown cancels pending polling and debounce timers
  // -------------------------------------------------------------------------
  it('cancels the polling timer on shutdown so no further fetches occur', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      await Promise.resolve()
      return new Response(JSON.stringify(makeVariablesConfig()), { status: 200 })
    })

    const provider = new LogfireRemoteVariableProvider({
      apiKey: 'test-key',
      baseUrl: 'https://example.com',
      fetch: fetchImpl,
      polling: true,
      pollingInterval: 10, // minimum (10s)
      sse: false,
    })

    provider.start()
    provider.shutdown()

    // Advance well past several polling intervals; no fetch should occur
    await vi.advanceTimersByTimeAsync(300_000)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('cancels the debounce timer on shutdown so no follow-up fetch fires', async () => {
    let sseController: ReadableStreamDefaultController<Uint8Array> | undefined
    const fetchImpl = vi.fn<typeof fetch>(async (input, _init) => {
      await Promise.resolve()
      const url = requestUrl(input)
      if (url.includes('/v1/variable-updates/')) {
        const stream = new ReadableStream<Uint8Array>({
          start(ctrl) {
            sseController = ctrl
          },
        })
        return new Response(stream, { status: 200 })
      }
      return new Response(JSON.stringify(makeVariablesConfig()), { status: 200 })
    })

    const provider = new LogfireRemoteVariableProvider({
      apiKey: 'test-key',
      baseUrl: 'https://example.com',
      fetch: fetchImpl,
      polling: false,
      sse: true,
    })

    provider.start()
    // Wait for SSE stream to start
    await vi.advanceTimersByTimeAsync(0)

    // Emit a variable update event to schedule the debounce timer
    const encoder = new TextEncoder()
    sseController?.enqueue(encoder.encode('data: {"event":"updated"}\n\n'))
    await vi.advanceTimersByTimeAsync(0)

    // Count fetches before shutdown
    const fetchesBefore = fetchImpl.mock.calls.filter(([input]) => requestUrl(input).includes('/v1/variables/')).length

    // Shutdown cancels the debounce
    provider.shutdown()

    // Advance past the 2000ms debounce delay
    await vi.advanceTimersByTimeAsync(3_000)

    // No additional fetches after shutdown
    const fetchesAfter = fetchImpl.mock.calls.filter(([input]) => requestUrl(input).includes('/v1/variables/')).length
    expect(fetchesAfter).toBe(fetchesBefore)
  })

  // -------------------------------------------------------------------------
  // 7. Debounced follow-up refresh fires ~2s after an SSE variable event
  // -------------------------------------------------------------------------
  it('schedules a debounced follow-up refresh 2s after an SSE variable event', async () => {
    let sseController: ReadableStreamDefaultController<Uint8Array> | undefined
    const fetchImpl = vi.fn<typeof fetch>(async (input, _init) => {
      await Promise.resolve()
      const url = requestUrl(input)
      if (url.includes('/v1/variable-updates/')) {
        const stream = new ReadableStream<Uint8Array>({
          start(ctrl) {
            sseController = ctrl
          },
        })
        return new Response(stream, { status: 200 })
      }
      return new Response(JSON.stringify(makeVariablesConfig()), { status: 200 })
    })

    const provider = new LogfireRemoteVariableProvider({
      apiKey: 'test-key',
      baseUrl: 'https://example.com',
      fetch: fetchImpl,
      polling: false,
      sse: true,
    })

    provider.start()
    await vi.advanceTimersByTimeAsync(0)

    // Emit an SSE variable event
    const encoder = new TextEncoder()
    sseController?.enqueue(encoder.encode('data: {"event":"created"}\n\n'))
    await vi.advanceTimersByTimeAsync(0)

    // The immediate refresh(true) should have fired
    const fetchesAfterEvent = fetchImpl.mock.calls.filter(([input]) => requestUrl(input).includes('/v1/variables/')).length
    expect(fetchesAfterEvent).toBeGreaterThanOrEqual(1)

    // Before 2s: no debounced follow-up yet
    await vi.advanceTimersByTimeAsync(1_999)
    const fetchesBefore2s = fetchImpl.mock.calls.filter(([input]) => requestUrl(input).includes('/v1/variables/')).length

    // After 2s: the debounced follow-up fires
    await vi.advanceTimersByTimeAsync(1)
    const fetchesAfter2s = fetchImpl.mock.calls.filter(([input]) => requestUrl(input).includes('/v1/variables/')).length
    expect(fetchesAfter2s).toBe(fetchesBefore2s + 1)

    provider.shutdown()
  })

  // -------------------------------------------------------------------------
  // 8. Multiple SSE events within 2s coalesce into a single debounced fetch
  // -------------------------------------------------------------------------
  it('coalesces multiple SSE events into a single debounced follow-up fetch', async () => {
    let sseController: ReadableStreamDefaultController<Uint8Array> | undefined
    const fetchImpl = vi.fn<typeof fetch>(async (input, _init) => {
      await Promise.resolve()
      const url = requestUrl(input)
      if (url.includes('/v1/variable-updates/')) {
        const stream = new ReadableStream<Uint8Array>({
          start(ctrl) {
            sseController = ctrl
          },
        })
        return new Response(stream, { status: 200 })
      }
      return new Response(JSON.stringify(makeVariablesConfig()), { status: 200 })
    })

    const provider = new LogfireRemoteVariableProvider({
      apiKey: 'test-key',
      baseUrl: 'https://example.com',
      fetch: fetchImpl,
      polling: false,
      sse: true,
    })

    provider.start()
    await vi.advanceTimersByTimeAsync(0)

    const encoder = new TextEncoder()

    // Emit three events in quick succession (within 2s window)
    sseController?.enqueue(encoder.encode('data: {"event":"created"}\n\n'))
    await vi.advanceTimersByTimeAsync(100)
    sseController?.enqueue(encoder.encode('data: {"event":"updated"}\n\n'))
    await vi.advanceTimersByTimeAsync(100)
    sseController?.enqueue(encoder.encode('data: {"event":"deleted"}\n\n'))
    await vi.advanceTimersByTimeAsync(0)

    // The three immediate refresh(true) calls have fired; count them
    const fetchesBeforeDebounce = fetchImpl.mock.calls.filter(([input]) => requestUrl(input).includes('/v1/variables/')).length

    // Advance past the 2s debounce window from the LAST event
    await vi.advanceTimersByTimeAsync(2_001)
    const fetchesAfterDebounce = fetchImpl.mock.calls.filter(([input]) => requestUrl(input).includes('/v1/variables/')).length

    // Exactly one debounced follow-up should fire, not three
    expect(fetchesAfterDebounce).toBe(fetchesBeforeDebounce + 1)

    provider.shutdown()
  })
})
