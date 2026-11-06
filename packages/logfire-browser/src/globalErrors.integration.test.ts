/**
 * @vitest-environment jsdom
 */
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-web'
import { ReplayUploadError } from '@pydantic/logfire-session-replay'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { configure, Level, reportError } from './index'
import type { LogfireConfigOptions } from './index'
import { ACTIVE_CONFIGURATION_ERROR } from './providerLifecycle'

vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class {
    export(_spans: unknown, resultCallback: (result: { code: number }) => void): void {
      resultCallback({ code: 0 })
    }

    async shutdown(): Promise<void> {
      return Promise.resolve()
    }
  },
}))

// Provider shutdown also shuts the exporter down, so each test gets its own.
let exporter = new InMemorySpanExporter()
let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

function start(options: Partial<LogfireConfigOptions> = {}): void {
  exporter = new InMemorySpanExporter()
  cleanup = configure({ spanProcessors: [new SimpleSpanProcessor(exporter)], traceUrl: '/client-traces', ...options })
}

describe('SDK-internal exception marking', () => {
  it('marks an SDK failure that reaches global capture', async () => {
    start()
    const failure = catchError(() => configure({ traceUrl: '/second-configure' }))
    expect(failure).toMatchObject({ message: ACTIVE_CONFIGURATION_ERROR })

    window.dispatchEvent(new ErrorEvent('error', { error: failure, message: 'uncaught' }))
    await nextTask()

    expect(exporter.getFinishedSpans().map((span) => [span.name, span.attributes['logfire.sdk.internal']])).toEqual([
      ['Uncaught error', true],
    ])
  })

  it('marks a replay failure that the application reports from sessionReplay.onError', () => {
    start()

    reportError(
      'Replay failed',
      new ReplayUploadError({ cause: new Error('network down'), reason: 'unconfirmed', seq: 7, sessionId: 'recording' })
    )

    const [span] = exporter.getFinishedSpans()
    expect(span?.attributes['exception.message']).toBe('replay chunk seq=7 unconfirmed: network down')
    expect(span?.attributes['logfire.sdk.internal']).toBe(true)
  })

  it('does not mark application errors', async () => {
    start()
    const sdkFailure = catchError(() => configure({ traceUrl: '/second-configure' }))

    dispatchRejection(new Error('rejected'))
    await nextTask()
    reportError('Application report', new Error('boom'))
    reportError('Wrapped by the application', new Error('save failed', { cause: sdkFailure }))
    reportError('Thrown string', 'boom')

    const spans = exporter.getFinishedSpans()
    expect(spans.map((span) => span.name)).toEqual([
      'Unhandled promise rejection',
      'Application report',
      'Wrapped by the application',
      'Thrown string',
    ])
    expect(spans.filter((span) => 'logfire.sdk.internal' in span.attributes)).toEqual([])
  })
})

describe('browser global error capture', () => {
  it('reports an uncaught error after the event dispatch completes', async () => {
    start()
    const error = new Error('boom')

    window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }))
    expect(errorSpans()).toEqual([])
    await nextTask()

    expect(errorSpans()).toEqual([{ level: Level.Error, message: 'boom', name: 'Uncaught error' }])
  })

  it('reports an unhandled promise rejection', async () => {
    start()

    dispatchRejection(new Error('rejected'))
    await nextTask()

    expect(errorSpans()).toEqual([{ level: Level.Error, message: 'rejected', name: 'Unhandled promise rejection' }])
  })

  it('scrubs a sensitive unhandled rejection message from the attribute, the event, and the status', async () => {
    start()

    dispatchRejection(new Error('session expired for hunter2-secret'))
    await nextTask()

    const [span] = exporter.getFinishedSpans()
    expect(span?.attributes['exception.message']).toBe("[Scrubbed due to 'session']")
    expect(span?.status.message).toBe("[Scrubbed due to 'session']")
    expect(JSON.stringify({ attributes: span?.attributes, events: span?.events, status: span?.status })).not.toContain('hunter2-secret')
  })

  it('reports a cross-origin script error by its message', async () => {
    start()

    window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }))
    await nextTask()

    expect(errorSpans()).toEqual([{ level: Level.Error, message: 'Script error.', name: 'Uncaught error' }])
  })

  it('ignores resource load failures', async () => {
    start()
    const image = document.createElement('img')
    document.body.append(image)

    image.dispatchEvent(new Event('error'))
    await nextTask()
    image.remove()

    expect(errorSpans()).toEqual([])
  })

  it('reports once when an application listener reports the same error', async () => {
    start()
    const applicationListener = (event: ErrorEvent) => {
      reportError('Application report', event.error)
    }
    window.addEventListener('error', applicationListener)
    const error = new Error('boom')

    window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }))
    await nextTask()
    window.removeEventListener('error', applicationListener)

    expect(errorSpans()).toEqual([{ level: Level.Error, message: 'boom', name: 'Application report' }])
  })

  it('reports once when the application reports an error and rethrows it', async () => {
    start()
    const error = new Error('boom')

    reportError('Caught error', error)
    window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }))
    await nextTask()

    expect(errorSpans()).toEqual([{ level: Level.Error, message: 'boom', name: 'Caught error' }])
  })

  it('does not listen when captureGlobalErrors is false', async () => {
    start({ captureGlobalErrors: false })

    await withTestErrorListener(async () => {
      window.dispatchEvent(new ErrorEvent('error', { error: new Error('boom'), message: 'boom' }))
      dispatchRejection(new Error('rejected'))
      await nextTask()
    })

    expect(errorSpans()).toEqual([])
  })

  it('stops reporting, including a pending report, on cleanup', async () => {
    start()

    window.dispatchEvent(new ErrorEvent('error', { error: new Error('pending'), message: 'pending' }))
    await cleanup?.()
    cleanup = undefined
    await withTestErrorListener(async () => {
      window.dispatchEvent(new ErrorEvent('error', { error: new Error('after cleanup'), message: 'after cleanup' }))
      await nextTask()
    })

    expect(errorSpans()).toEqual([])
  })
})

function catchError(callback: () => unknown): unknown {
  try {
    callback()
  } catch (error) {
    return error
  }
  throw new Error('expected the callback to throw')
}

function errorSpans(): { level: unknown; message: unknown; name: string }[] {
  return exporter.getFinishedSpans().map((span) => ({
    level: span.attributes['logfire.level_num'],
    message: span.attributes['exception.message'],
    name: span.name,
  }))
}

// Vitest reports an `error` event on a window without listeners as an uncaught test failure.
async function withTestErrorListener(callback: () => Promise<void>): Promise<void> {
  const listener = (event: Event) => {
    event.preventDefault()
  }
  window.addEventListener('error', listener)
  try {
    await callback()
  } finally {
    window.removeEventListener('error', listener)
  }
}

async function nextTask(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

function dispatchRejection(reason: unknown): void {
  const event = new Event('unhandledrejection') as Event & { reason: unknown }
  event.reason = reason
  window.dispatchEvent(event)
}
