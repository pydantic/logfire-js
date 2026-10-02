/**
 * @vitest-environment jsdom
 */
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-web'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { configure, startSpan } from './index'

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

const exporter = new InMemorySpanExporter()
let preventSpanCreation = false
let cleanup: (() => Promise<void>) | undefined

beforeAll(async () => {
  // The test compares the method identity and never calls it.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const unpatchedAddEventListener = EventTarget.prototype.addEventListener
  cleanup = configure({
    autoInstrumentations: {
      '@opentelemetry/instrumentation-document-load': { enabled: false },
      '@opentelemetry/instrumentation-fetch': { enabled: false },
      '@opentelemetry/instrumentation-user-interaction': {
        eventNames: ['click'],
        shouldPreventSpanCreation: () => preventSpanCreation,
      },
      '@opentelemetry/instrumentation-xml-http-request': { enabled: false },
    },
    spanProcessors: [new SimpleSpanProcessor(exporter)],
    traceUrl: '/client-traces',
  })
  // The auto-instrumentations load through a dynamic import. A listener added before the
  // instrumentation wraps `addEventListener` never gets a span, so a test would pass for the wrong reason.
  await waitUntil(() => EventTarget.prototype.addEventListener !== unpatchedAddEventListener)
})

afterAll(async () => {
  await cleanup?.()
})

beforeEach(() => {
  preventSpanCreation = false
  exporter.reset()
  document.body.replaceChildren()
})

describe('browser user interaction spans', () => {
  it('exports one click span when one click reaches several listeners', () => {
    const { button, removeListeners } = mountButtonWithListeners()

    button.click()
    removeListeners()

    const clicks = clickSpans()
    expect(clicks).toHaveLength(1)
    expect(clicks[0]?.parentSpanContext).toBeUndefined()
  })

  it('parents work that a later listener starts to the click span', () => {
    const { button, removeListeners } = mountButtonWithListeners(() => {
      startSpan('work started by a later listener').end()
    })

    button.click()
    removeListeners()

    const clicks = clickSpans()
    const work = exporter.getFinishedSpans().find(({ name }) => name === 'work started by a later listener')
    expect(clicks).toHaveLength(1)
    expect(work?.spanContext().traceId).toBe(clicks[0]?.spanContext().traceId)
    expect(work?.parentSpanContext?.spanId).toBe(clicks[0]?.spanContext().spanId)
  })

  it('starts a separate trace for each consecutive click', () => {
    const { button, removeListeners } = mountButtonWithListeners()

    button.click()
    button.click()
    removeListeners()

    const clicks = clickSpans()
    expect(clicks).toHaveLength(2)
    expect(clicks.map((span) => span.parentSpanContext)).toEqual([undefined, undefined])
    expect(clicks[0]?.spanContext().traceId).not.toBe(clicks[1]?.spanContext().traceId)
  })

  it('keeps a configured shouldPreventSpanCreation hook in effect', () => {
    preventSpanCreation = true
    const calls: string[] = []
    const { button, removeListeners } = mountButtonWithListeners(() => {
      calls.push('app')
    })

    button.click()
    removeListeners()

    expect(clickSpans()).toEqual([])
    expect(calls).toEqual(['app'])
  })
})

function mountButtonWithListeners(appListener: () => void = () => undefined): {
  button: HTMLButtonElement
  removeListeners: () => void
} {
  const button = document.createElement('button')
  button.textContent = 'Save'
  document.body.append(button)
  // A capture listener on the document runs before the application handler, as a session
  // recorder's listener does. The application handler is the last listener the click reaches.
  const captureListener = (): void => undefined
  const buttonListener = (): void => undefined
  document.addEventListener('click', captureListener, true)
  button.addEventListener('click', buttonListener)
  document.addEventListener('click', appListener)
  return {
    button,
    removeListeners: () => {
      document.removeEventListener('click', captureListener, true)
      button.removeEventListener('click', buttonListener)
      document.removeEventListener('click', appListener)
    },
  }
}

function clickSpans(): ReturnType<InMemorySpanExporter['getFinishedSpans']> {
  return exporter.getFinishedSpans().filter(({ name }) => name === 'click' || name.startsWith('click '))
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  return waitUntilDeadline(predicate, Date.now() + 5_000)
}

async function waitUntilDeadline(predicate: () => boolean, deadline: number): Promise<void> {
  if (predicate()) {
    return
  }
  if (Date.now() >= deadline) {
    throw new Error('timed out waiting for the user interaction instrumentation')
  }
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
  return waitUntilDeadline(predicate, deadline)
}
