/** @vitest-environment jsdom */
import { webcrypto } from 'node:crypto'
import type { ExportResult } from '@opentelemetry/core'
import { ExportResultCode } from '@opentelemetry/core'
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-web'
import { WebTracerProvider } from '@opentelemetry/sdk-trace-web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { FakeLockManager } from '../../logfire-session-replay/src/fakeLockManager.testing'

import { RecoveringSpanExporter } from './RecoveringSpanExporter'
import { LogfireSpanProcessor } from './LogfireSpanProcessor'

const success: ExportResult = { code: ExportResultCode.SUCCESS }
const failure: ExportResult = { code: ExportResultCode.FAILED, error: new Error('cancelled') }

function createExporter(
  options: { url?: string; headers?: () => Promise<Record<string, string>>; key?: string; concurrencyLimit?: number } = {}
) {
  const callbacks: ((result: ExportResult) => void)[] = []
  const sentHeaders: Record<string, string>[] = []
  const inner: SpanExporter = {
    export: () => undefined,
    shutdown: async () => Promise.resolve(),
  }
  const exporter = new RecoveringSpanExporter(
    (headers) => {
      inner.export = (_spans, callback) => {
        headers()
          .then((value) => {
            sentHeaders.push(value)
            callbacks.push(callback)
          })
          .catch(() => {
            callback(failure)
          })
      }
      return inner
    },
    { url: options.url ?? 'https://collector.example/v1/traces', timeoutMillis: 1_000, concurrencyLimit: options.concurrencyLimit ?? 30 },
    options.headers ?? (async () => Promise.resolve({ Authorization: 'Bearer original-token' })),
    options.key === undefined ? {} : { key: options.key }
  )
  return { exporter, callbacks, sentHeaders, inner }
}

function createSpans(): ReadableSpan[] {
  const spans: ReadableSpan[] = []
  const provider = new WebTracerProvider({
    spanProcessors: [
      new LogfireSpanProcessor(
        {
          onStart: () => undefined,
          onEnd: (span) => {
            spans.push(span)
          },
          forceFlush: async () => Promise.resolve(),
          shutdown: async () => Promise.resolve(),
        },
        false
      ),
    ],
  })
  const span = provider.getTracer('original-scope', '1.0').startSpan('before navigation', { attributes: { password: 'private-value' } })
  span.addEvent('original event', { password: 'private-value' })
  span.end()
  return spans
}

async function ready(exporter: RecoveringSpanExporter): Promise<void> {
  await exporter.startRecovery()
}

function storedBody(): string {
  const key = sessionStorage.key(0) ?? ''
  return (JSON.parse(sessionStorage.getItem(key) ?? '{}') as { body: string }).body
}

let locks: FakeLockManager
function leaveDocument(): void {
  for (const key of Object.keys(sessionStorage)) {
    const record = JSON.parse(sessionStorage.getItem(key) ?? '{}') as { owner: string }
    locks.drop(record.owner)
  }
}

beforeEach(() => {
  locks = new FakeLockManager()
  vi.stubGlobal('navigator', { locks })

  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () => Promise.resolve(new Response('{}', { status: 200 })))
  )
})

afterEach(() => {
  sessionStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('RecoveringSpanExporter', () => {
  it('recovers an in-flight request with its original scrubbed payload, IDs and resource', async () => {
    const old = createExporter()
    await ready(old.exporter)
    const spans = createSpans()
    old.exporter.export(spans, () => undefined)
    await vi.waitFor(() => {
      expect(old.callbacks).toHaveLength(1)
    })
    const expected = new TextDecoder().decode(JsonTraceSerializer.serializeRequest(spans))
    expect(storedBody()).toBe(expected)
    expect(storedBody()).not.toContain('private-value')
    expect(JSON.stringify(Object.keys(sessionStorage).map((key) => sessionStorage.getItem(key)))).not.toContain('original-token')

    leaveDocument()
    const next = createExporter()
    await ready(next.exporter)
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
    const [url, request] = vi.mocked(fetch).mock.calls[0] ?? []
    expect(url).toBe('https://collector.example/v1/traces')
    expect(request?.body).toBe(expected)
    expect([...new Headers(request?.headers).entries()]).toEqual([
      ['authorization', 'Bearer original-token'],
      ['content-type', 'application/json'],
    ])
    expect(sessionStorage.length).toBe(0)
  })

  it('keeps failed exports and removes only successful ones', async () => {
    const { exporter, callbacks } = createExporter()
    await ready(exporter)
    exporter.export(createSpans(), () => undefined)
    exporter.export(createSpans(), () => undefined)
    await vi.waitFor(() => {
      expect(callbacks).toHaveLength(2)
    })
    callbacks[0]?.(failure)
    expect(sessionStorage.length).toBe(2)
    callbacks[1]?.(success)
    await exporter.forceFlush()
    expect(sessionStorage.length).toBe(1)
    await exporter.shutdown()
  })

  it.each([
    { url: 'https://other.example/v1/traces' },
    { headers: async () => Promise.resolve({ Authorization: 'Bearer different-token' }) },
    { key: 'another-tenant' },
  ])('does not recover across destination identities: %o', async (options) => {
    const old = createExporter()
    await ready(old.exporter)
    old.exporter.export(createSpans(), () => undefined)
    await vi.waitFor(() => {
      expect(old.callbacks).toHaveLength(1)
    })
    await ready(createExporter(options).exporter)
    expect(fetch).not.toHaveBeenCalled()
    expect(sessionStorage.length).toBe(1)
  })

  it('persists the first request after headers change under its new identity', async () => {
    let token = 'first'
    const { exporter, callbacks } = createExporter({ headers: async () => Promise.resolve({ Authorization: token }) })
    await ready(exporter)
    token = 'second'
    exporter.export(createSpans(), () => undefined)
    expect(sessionStorage.length).toBe(0)
    await vi.waitFor(() => {
      expect(callbacks).toHaveLength(1)
    })
    expect(sessionStorage.length).toBe(1)
    leaveDocument()
    await ready(createExporter({ headers: async () => Promise.resolve({ Authorization: 'first' }) }).exporter)
    expect(fetch).not.toHaveBeenCalled()
    await ready(createExporter({ headers: async () => Promise.resolve({ Authorization: 'second' }) }).exporter)
    expect(fetch).toHaveBeenCalledTimes(1)
    callbacks[0]?.(success)
    await exporter.shutdown()
  })

  it('does not let an old acknowledgment remove newer requests', async () => {
    const old = createExporter()
    await ready(old.exporter)
    old.exporter.export(createSpans(), () => undefined)
    await vi.waitFor(() => {
      expect(old.callbacks).toHaveLength(1)
    })
    leaveDocument()
    const next = createExporter()
    await ready(next.exporter)
    next.exporter.export(createSpans(), () => undefined)
    await vi.waitFor(() => {
      expect(next.callbacks).toHaveLength(1)
    })
    const newer = storedBody()
    old.callbacks[0]?.(success)
    await old.exporter.forceFlush()
    expect(storedBody()).toBe(newer)
  })

  it('keeps concurrent requests tied to their own header snapshots', async () => {
    let token = 'first'
    const current = createExporter({ headers: async () => Promise.resolve({ Authorization: token }) })
    await ready(current.exporter)
    const firstSpans = createSpans()
    current.exporter.export(firstSpans, () => undefined)
    await vi.waitFor(() => {
      expect(current.callbacks).toHaveLength(1)
    })
    token = 'second'
    current.exporter.export(createSpans(), () => undefined)
    await vi.waitFor(() => {
      expect(current.callbacks).toHaveLength(2)
    })
    expect(current.sentHeaders).toEqual([{ Authorization: 'first' }, { Authorization: 'second' }])
    expect(sessionStorage.length).toBe(2)
    expect(storedBody()).toBe(new TextDecoder().decode(JsonTraceSerializer.serializeRequest(firstSpans)))
    leaveDocument()
    const next = createExporter({ headers: async () => Promise.resolve({ Authorization: 'first' }) })
    await ready(next.exporter)
    expect(new Headers(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).get('authorization')).toBe('first')
    expect(sessionStorage.length).toBe(1)
  })

  it('does not save a request while its header factory is still pending', async () => {
    let resolveHeaders: () => Promise<Record<string, string>> = async () => Promise.resolve({ Authorization: 'first' })
    const current = createExporter({ headers: async () => resolveHeaders() })
    await ready(current.exporter)
    let finishHeaders!: (headers: Record<string, string>) => void
    resolveHeaders = async () =>
      new Promise((resolve) => {
        finishHeaders = resolve
      })
    current.exporter.export(createSpans(), () => undefined)
    expect(sessionStorage.length).toBe(0)
    await vi.waitFor(() => {
      expect(finishHeaders).toBeTypeOf('function')
    })
    finishHeaders({ Authorization: 'second' })
    await vi.waitFor(() => {
      expect(current.callbacks).toHaveLength(1)
    })
    expect(current.sentHeaders).toEqual([{ Authorization: 'second' }])
    expect(sessionStorage.length).toBe(1)
  })

  it.each([400, 401, 403, 413, 429, 503])('continues recovery after HTTP %s', async (status) => {
    const old = createExporter()
    await ready(old.exporter)
    old.exporter.export(createSpans(), () => undefined)
    old.exporter.export(createSpans(), () => undefined)
    await vi.waitFor(() => {
      expect(old.callbacks).toHaveLength(2)
    })
    leaveDocument()
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status }))
    await ready(createExporter().exporter)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(sessionStorage.length).toBe(status === 429 || status === 503 ? 1 : 0)
  })

  it('does not recover requests owned by a live SDK instance or iframe', async () => {
    const old = createExporter()
    await ready(old.exporter)
    old.exporter.export(createSpans(), () => undefined)
    await vi.waitFor(() => {
      expect(old.callbacks).toHaveLength(1)
    })
    await ready(createExporter().exporter)
    expect(fetch).not.toHaveBeenCalled()
    expect(sessionStorage.length).toBe(1)
  })

  it('uses the initial absolute URL after SPA navigation', async () => {
    const urls: string[] = []
    const exporter = new RecoveringSpanExporter(
      (_headers, url) => {
        urls.push(url)
        return {
          export: (_spans, callback) => {
            callback(success)
          },
          shutdown: async () => Promise.resolve(),
        }
      },
      { url: 'traces' },
      async () => Promise.resolve({})
    )
    const expected = new URL('traces', location.href).href
    await ready(exporter)
    history.pushState({}, '', '/new/route/')
    try {
      exporter.export(createSpans(), () => undefined)
      await exporter.forceFlush()
      expect(urls).toEqual([expected, expected])
    } finally {
      history.replaceState({}, '', '/')
      await exporter.shutdown()
    }
  })

  it('exports without persistence when Web Locks are unavailable', async () => {
    vi.stubGlobal('navigator', {})
    const current = createExporter()
    await ready(current.exporter)
    current.exporter.export(createSpans(), () => undefined)
    await vi.waitFor(() => {
      expect(current.callbacks).toHaveLength(1)
    })
    expect(sessionStorage.length).toBe(0)
    current.callbacks[0]?.(success)
    await current.exporter.shutdown()
  })

  it('continues normal exporting when storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const { exporter, callbacks } = createExporter()
    await ready(exporter)
    const result = vi.fn<(result: ExportResult) => void>()
    exporter.export(createSpans(), result)
    await vi.waitFor(() => {
      expect(callbacks).toHaveLength(1)
    })
    callbacks[0]?.(success)
    await exporter.forceFlush()
    expect(result).toHaveBeenCalledExactlyOnceWith(success)
    await exporter.shutdown()
  })

  it('does not start recovery after shutdown', async () => {
    const old = createExporter()
    await ready(old.exporter)
    old.exporter.export(createSpans(), () => undefined)
    await vi.waitFor(() => {
      expect(old.callbacks).toHaveLength(1)
    })
    const next = createExporter()
    const recovery = next.exporter.startRecovery()
    await next.exporter.shutdown()
    await recovery
    expect(fetch).not.toHaveBeenCalled()
    expect(sessionStorage.length).toBe(1)
  })

  it('bounds background recovery and aborts it on shutdown', async () => {
    const old = createExporter()
    await ready(old.exporter)
    for (let i = 0; i < 6; i += 1) {
      old.exporter.export(createSpans(), () => undefined)
    }
    await vi.waitFor(() => {
      expect(old.callbacks).toHaveLength(6)
    })
    leaveDocument()
    const signals: AbortSignal[] = []
    vi.mocked(fetch).mockImplementation(
      async (_url, options) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = options?.signal
          if (signal === undefined || signal === null) {
            throw new Error('Missing abort signal')
          }
          signals.push(signal)
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'))
          })
        })
    )
    const next = createExporter()
    const recovery = next.exporter.startRecovery()
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(4)
    })
    await next.exporter.forceFlush()
    expect(next.exporter.pendingExports).toBe(4)
    await next.exporter.shutdown()
    await recovery
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(sessionStorage.length).toBe(6)
  })

  it('does not block forceFlush and gives live exports priority over recovery', async () => {
    const old = createExporter()
    await ready(old.exporter)
    old.exporter.export(createSpans(), () => undefined)
    await vi.waitFor(() => {
      expect(old.callbacks).toHaveLength(1)
    })
    leaveDocument()
    vi.mocked(fetch).mockImplementation(
      async (_url, options) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'))
          })
        })
    )
    const next = createExporter({ concurrencyLimit: 1 })
    const recovery = next.exporter.startRecovery()
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1)
    })
    await next.exporter.forceFlush()
    expect(next.exporter.pendingExports).toBe(1)
    const result = vi.fn<(result: ExportResult) => void>()
    next.exporter.export(createSpans(), result)
    await vi.waitFor(() => {
      expect(next.callbacks).toHaveLength(1)
    })
    expect(next.exporter.pendingExports).toBe(1)
    next.callbacks[0]?.(success)
    await next.exporter.forceFlush()
    await recovery
    expect(result).toHaveBeenCalledExactlyOnceWith(success)
    expect(sessionStorage.length).toBe(1)
    await next.exporter.shutdown()
  })
})
