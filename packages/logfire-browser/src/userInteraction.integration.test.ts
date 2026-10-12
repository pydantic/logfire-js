/**
 * @vitest-environment jsdom
 */
import { hrTimeToNanoseconds } from '@opentelemetry/core'
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
const startupListener = (): void => undefined

beforeAll(() => {
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
  // Registered in the same task as configure(), as a framework root registers its delegated listeners
  // during application startup. The instrumentation never wraps a listener added before its patch.
  document.addEventListener('click', startupListener)
})

afterAll(async () => {
  document.removeEventListener('click', startupListener)
  await cleanup?.()
})

beforeEach(() => {
  preventSpanCreation = false
  exporter.reset()
  document.body.replaceChildren()
})

describe('browser user interaction spans', () => {
  it('exports a click span for a listener registered right after configure', async () => {
    const button = document.createElement('button')
    document.body.append(button)

    button.click()
    await nextTask()

    expect(clickSpans()).toHaveLength(1)
  })

  it('exports one click span when one click reaches several listeners', async () => {
    const { button, removeListeners } = mountButtonWithListeners()

    button.click()
    removeListeners()
    await nextTask()

    const clicks = clickSpans()
    expect(clicks).toHaveLength(1)
    expect(clicks[0]?.parentSpanContext).toBeUndefined()
  })

  it('parents work that a later listener starts to the click span', async () => {
    const { button, removeListeners } = mountButtonWithListeners(() => {
      startSpan('work started by a later listener').end()
    })

    button.click()
    removeListeners()
    await nextTask()

    const clicks = clickSpans()
    const work = exporter.getFinishedSpans().find(({ name }) => name === 'work started by a later listener')
    expect(clicks).toHaveLength(1)
    expect(work?.spanContext().traceId).toBe(clicks[0]?.spanContext().traceId)
    expect(work?.parentSpanContext?.spanId).toBe(clicks[0]?.spanContext().spanId)
  })

  it('starts a separate trace for each consecutive click', async () => {
    const { button, removeListeners } = mountButtonWithListeners()

    button.click()
    button.click()
    removeListeners()
    await nextTask()
    await nextTask()

    const clicks = clickSpans()
    expect(clicks).toHaveLength(2)
    expect(clicks.map((span) => span.parentSpanContext)).toEqual([undefined, undefined])
    expect(clicks[0]?.spanContext().traceId).not.toBe(clicks[1]?.spanContext().traceId)
  })

  it('keeps a configured shouldPreventSpanCreation hook in effect', async () => {
    preventSpanCreation = true
    const calls: string[] = []
    const { button, removeListeners } = mountButtonWithListeners(() => {
      calls.push('app')
    })

    button.click()
    removeListeners()
    await nextTask()

    expect(clickSpans()).toEqual([])
    expect(calls).toEqual(['app'])
  })
  it('keeps the click span open until the last listener returns', async () => {
    const { button, removeListeners } = mountButtonWithListeners(() => {
      startSpan('work in the last listener').end()
    })

    button.click()
    removeListeners()
    await nextTask()

    const [click] = clickSpans()
    const work = exporter.getFinishedSpans().find(({ name }) => name === 'work in the last listener')
    expect(click).toBeDefined()
    expect(work).toBeDefined()
    expect(hrTimeToNanoseconds(click?.endTime ?? [0, 0]) >= hrTimeToNanoseconds(work?.endTime ?? [0, 0])).toBe(true)
  })

  it('ends the click span when a listener throws', async () => {
    const button = document.createElement('button')
    document.body.append(button)
    button.addEventListener('click', () => {
      throw new Error('listener failed')
    })
    const ignoreReportedError = (event: Event) => {
      event.preventDefault()
    }
    window.addEventListener('error', ignoreReportedError)

    button.click()
    await nextTask()
    window.removeEventListener('error', ignoreReportedError)

    expect(clickSpans()).toHaveLength(1)
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

async function nextTask(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

function clickSpans(): ReturnType<InMemorySpanExporter['getFinishedSpans']> {
  return exporter.getFinishedSpans().filter(({ name }) => name === 'click' || name.startsWith('click '))
}
