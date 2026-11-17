import { afterEach, expect, it, vi } from 'vite-plus/test'
import { recoverTraceRequest } from './recoverTraceRequest'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it.each([
  [200, 'success'],
  [400, 'permanent-failure'],
  [401, 'permanent-failure'],
  [413, 'permanent-failure'],
  [408, 'retryable-failure'],
  [429, 'retryable-failure'],
  [500, 'retryable-failure'],
  [502, 'retryable-failure'],
  [503, 'retryable-failure'],
  [504, 'retryable-failure'],
])('classifies HTTP %s and releases its response body', async (status, expected) => {
  const response = new Response('{}', { status })
  if (response.body === null) {
    throw new Error('Missing response body')
  }
  const cancel = vi.spyOn(response.body, 'cancel')
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response))
  expect(await recoverTraceRequest('https://collector.example/traces', '{}', {}, 1_000, new AbortController().signal)).toBe(expected)
  expect(cancel).toHaveBeenCalledOnce()
})

it('uses the uninstrumented fetch with the original payload and headers', async () => {
  const original = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'))
  const instrumented = Object.assign(vi.fn<typeof fetch>(), { __original: original })
  vi.stubGlobal('fetch', instrumented)
  expect(
    await recoverTraceRequest(
      'https://collector.example/traces',
      '{"resourceSpans":[]}',
      { Authorization: 'token' },
      1_000,
      new AbortController().signal
    )
  ).toBe('success')
  expect(instrumented).not.toHaveBeenCalled()
  expect(original).toHaveBeenCalledExactlyOnceWith('https://collector.example/traces', {
    method: 'POST',
    body: '{"resourceSpans":[]}',
    headers: new Headers({ authorization: 'token', 'content-type': 'application/json' }),
    keepalive: false,
    signal: original.mock.calls[0]?.[1]?.signal,
  })
})

it('aborts a timed-out request and retains it', async () => {
  vi.useFakeTimers()
  let signal: AbortSignal | undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (_url: string, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          signal = options.signal ?? undefined
          signal?.addEventListener('abort', () => {
            reject(new Error('aborted'))
          })
        })
    )
  )
  const result = recoverTraceRequest('https://collector.example/traces', '{}', {}, 1_000, new AbortController().signal)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(await result).toBe('retryable-failure')
  expect(signal?.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
