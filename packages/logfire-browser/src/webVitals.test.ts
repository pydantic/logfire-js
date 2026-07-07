/* eslint-disable import/first */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

type WebVitalName = 'CLS' | 'FCP' | 'INP' | 'LCP' | 'TTFB'

interface WebVitalRegistration {
  callback: (metric: unknown) => void
  options: unknown
}

const mocks = vi.hoisted(() => {
  type MockWebVitalName = 'CLS' | 'FCP' | 'INP' | 'LCP' | 'TTFB'
  interface MockSpan {
    attributes: Record<string, unknown>
    endCalls: number
    name: string
    end: () => void
    setAttributes: (attributes: Record<string, unknown>) => MockSpan
  }

  const registrations: Record<MockWebVitalName, WebVitalRegistration[]> = {
    CLS: [],
    FCP: [],
    INP: [],
    LCP: [],
    TTFB: [],
  }
  const spans: MockSpan[] = []
  const diagErrors: unknown[][] = []
  const tracerNames: string[] = []
  let startSpanErrorMessage: string | undefined

  return {
    diagErrors,
    get startSpanErrorMessage() {
      return startSpanErrorMessage
    },
    set startSpanErrorMessage(message: string | undefined) {
      startSpanErrorMessage = message
    },
    register(name: MockWebVitalName, callback: (metric: unknown) => void, options: unknown) {
      registrations[name].push({ callback, options })
    },
    registrations,
    reset() {
      for (const registrationsForMetric of Object.values(registrations)) {
        registrationsForMetric.length = 0
      }
      spans.length = 0
      diagErrors.length = 0
      tracerNames.length = 0
      startSpanErrorMessage = undefined
    },
    spans,
    startSpan(name: string) {
      if (startSpanErrorMessage !== undefined) {
        throw new Error(startSpanErrorMessage)
      }

      const span: MockSpan = {
        attributes: {},
        endCalls: 0,
        name,
        end() {
          this.endCalls++
        },
        setAttributes(attributes) {
          Object.assign(this.attributes, attributes)
          return this
        },
      }
      spans.push(span)
      return span
    },
    tracerNames,
  }
})

vi.mock('@opentelemetry/api', () => ({
  diag: {
    error: (...args: unknown[]) => {
      mocks.diagErrors.push(args)
    },
  },
}))

vi.mock('web-vitals/attribution', () => ({
  onCLS: (callback: (metric: unknown) => void, options: unknown) => {
    mocks.register('CLS', callback, options)
  },
  onFCP: (callback: (metric: unknown) => void, options: unknown) => {
    mocks.register('FCP', callback, options)
  },
  onINP: (callback: (metric: unknown) => void, options: unknown) => {
    mocks.register('INP', callback, options)
  },
  onLCP: (callback: (metric: unknown) => void, options: unknown) => {
    mocks.register('LCP', callback, options)
  },
  onTTFB: (callback: (metric: unknown) => void, options: unknown) => {
    mocks.register('TTFB', callback, options)
  },
}))

import { resetBrowserWebVitalsForTests, startBrowserWebVitals } from './webVitals'

const webVitalNames: WebVitalName[] = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB']

function getRegistration(name: WebVitalName): WebVitalRegistration {
  const registration = mocks.registrations[name][0]
  if (registration === undefined) {
    throw new Error(`expected ${name} to be registered`)
  }
  return registration
}

function report(name: WebVitalName, metric: unknown): void {
  getRegistration(name).callback(metric)
}

function createMetric(name: WebVitalName, attribution: Record<string, unknown>): Record<string, unknown> {
  return {
    attribution,
    delta: 12,
    entries: [{ name: 'entry-object' }],
    id: `${name.toLowerCase()}-1`,
    name,
    navigationType: 'navigate',
    rating: 'good',
    value: 123,
  }
}

function createMetricRecorder() {
  return {
    record: vi.fn<(metric: unknown) => void>(),
    shutdown: vi.fn<() => void>(),
  }
}

function createTracer(name = 'logfire-web-vitals') {
  return {
    startSpan: (spanName: string) => {
      mocks.tracerNames.push(name)
      return mocks.startSpan(spanName)
    },
  }
}

async function startWebVitals(options: Omit<Parameters<typeof startBrowserWebVitals>[0], 'tracer'> = {}, tracer = createTracer()) {
  return startBrowserWebVitals({
    ...options,
    tracer: tracer as never,
  })
}

describe('browser Web Vitals reporting', () => {
  beforeEach(() => {
    mocks.reset()
    resetBrowserWebVitalsForTests()
  })

  afterEach(() => {
    resetBrowserWebVitalsForTests()
  })

  it('registers all Web Vitals callbacks with shared options', async () => {
    const generateTarget = () => 'custom-target'

    await startWebVitals({
      generateTarget,
      includeProcessedEventEntries: true,
      reportAllChanges: true,
    })

    for (const name of webVitalNames) {
      expect(mocks.registrations[name]).toHaveLength(1)
    }
    expect(getRegistration('LCP').options).toEqual({
      generateTarget,
      reportAllChanges: true,
    })
    expect(getRegistration('INP').options).toEqual({
      generateTarget,
      includeProcessedEventEntries: true,
      reportAllChanges: true,
    })
  })

  it('defaults INP processed event entries to false', async () => {
    await startWebVitals()

    expect(getRegistration('INP').options).toEqual({
      includeProcessedEventEntries: false,
    })
  })

  it('does not register duplicate observers in one page lifecycle', async () => {
    await startWebVitals({ reportAllChanges: true })
    await startWebVitals({ reportAllChanges: false })

    for (const name of webVitalNames) {
      expect(mocks.registrations[name]).toHaveLength(1)
    }
    expect(getRegistration('LCP').options).toEqual({ reportAllChanges: true })
  })

  it('records Web Vitals through the configured metric recorder', async () => {
    const metricRecorder = createMetricRecorder()
    const metric = createMetric('LCP', {
      resourceLoadDelay: 10,
      resourceLoadDuration: 20,
      target: '#hero img',
      timeToFirstByte: 40,
    })

    const handle = await startWebVitals({ metricRecorder })

    report('LCP', metric)

    expect(metricRecorder.record).toHaveBeenCalledWith(metric)
    expect(mocks.spans).toHaveLength(1)
    expect(mocks.spans[0]?.attributes).toMatchObject({
      'web_vital.lcp.target': '#hero img',
      'web_vital.value': 123,
    })

    await handle.shutdown()
    expect(metricRecorder.shutdown).toHaveBeenCalledTimes(1)
  })

  it('uses the latest metric recorder when duplicate startup is requested', async () => {
    const firstMetricRecorder = createMetricRecorder()
    const secondMetricRecorder = createMetricRecorder()
    const metric = createMetric('FCP', { firstByteToFCP: 85, loadState: 'dom-interactive', timeToFirstByte: 42 })

    await startWebVitals({ metricRecorder: firstMetricRecorder }, createTracer('first-tracer'))
    await startWebVitals({ metricRecorder: secondMetricRecorder }, createTracer('second-tracer'))
    report('FCP', metric)

    for (const name of webVitalNames) {
      expect(mocks.registrations[name]).toHaveLength(1)
    }
    expect(firstMetricRecorder.record).not.toHaveBeenCalled()
    expect(secondMetricRecorder.record).toHaveBeenCalledWith(metric)
    expect(mocks.tracerNames).toContain('second-tracer')
  })

  it('attaches a metric recorder after Web Vitals already started without metrics', async () => {
    const metricRecorder = createMetricRecorder()
    const beforeRecorder = createMetric('FCP', { firstByteToFCP: 85, loadState: 'dom-interactive', timeToFirstByte: 42 })
    const afterRecorder = createMetric('TTFB', { waitingDuration: 1 })

    await startWebVitals()
    report('FCP', beforeRecorder)

    await startWebVitals({ metricRecorder })
    report('TTFB', afterRecorder)

    for (const name of webVitalNames) {
      expect(mocks.registrations[name]).toHaveLength(1)
    }
    expect(metricRecorder.record).toHaveBeenCalledTimes(1)
    expect(metricRecorder.record).toHaveBeenCalledWith(afterRecorder)
  })

  it('does not let an older handle shutdown clear a newer metric recorder', async () => {
    const firstMetricRecorder = createMetricRecorder()
    const secondMetricRecorder = createMetricRecorder()
    const metric = createMetric('LCP', {
      resourceLoadDelay: 10,
      resourceLoadDuration: 20,
      target: '#hero img',
      timeToFirstByte: 40,
    })

    const firstHandle = await startWebVitals({ metricRecorder: firstMetricRecorder }, createTracer('first-tracer'))
    const secondHandle = await startWebVitals({ metricRecorder: secondMetricRecorder }, createTracer('second-tracer'))

    await firstHandle.shutdown()
    report('LCP', metric)

    expect(firstMetricRecorder.shutdown).toHaveBeenCalledTimes(1)
    expect(firstMetricRecorder.record).not.toHaveBeenCalled()
    expect(secondMetricRecorder.record).toHaveBeenCalledWith(metric)
    expect(mocks.tracerNames).toContain('second-tracer')

    await secondHandle.shutdown()
    report('LCP', metric)

    expect(secondMetricRecorder.shutdown).toHaveBeenCalledTimes(1)
    expect(secondMetricRecorder.record).toHaveBeenCalledTimes(1)
  })

  it('creates a span with base attributes for each report', async () => {
    await startWebVitals()

    report('FCP', createMetric('FCP', { firstByteToFCP: 85, loadState: 'dom-interactive', timeToFirstByte: 42 }))

    expect(mocks.tracerNames).toEqual(['logfire-web-vitals'])
    expect(mocks.spans).toHaveLength(1)
    expect(mocks.spans[0]?.name).toBe('web_vital.fcp')
    expect(mocks.spans[0]?.endCalls).toBe(1)
    expect(mocks.spans[0]?.attributes).toMatchObject({
      'web_vital.delta': 12,
      'web_vital.id': 'fcp-1',
      'web_vital.name': 'FCP',
      'web_vital.navigation_type': 'navigate',
      'web_vital.rating': 'good',
      'web_vital.value': 123,
    })
  })

  it('maps LCP attribution from target and emits the compatibility element alias', async () => {
    await startWebVitals()

    report(
      'LCP',
      createMetric('LCP', {
        element: 'old-platform-field',
        elementRenderDelay: 30,
        lcpEntry: { entryType: 'largest-contentful-paint' },
        resourceLoadDelay: 10,
        resourceLoadDuration: 20,
        target: '#hero img',
        timeToFirstByte: 40,
        url: 'https://cdn.example.com/hero.png',
      })
    )

    expect(mocks.spans[0]?.attributes).toMatchObject({
      'web_vital.lcp.element': '#hero img',
      'web_vital.lcp.element_render_delay': 30,
      'web_vital.lcp.resource_load_delay': 10,
      'web_vital.lcp.resource_load_duration': 20,
      'web_vital.lcp.target': '#hero img',
      'web_vital.lcp.time_to_first_byte': 40,
      'web_vital.lcp.url': 'https://cdn.example.com/hero.png',
    })
    expect(Object.values(mocks.spans[0]?.attributes ?? {}).every((value) => ['boolean', 'number', 'string'].includes(typeof value))).toBe(
      true
    )
  })

  it('maps INP, CLS, FCP, and TTFB attribution primitives', async () => {
    await startWebVitals()

    report(
      'INP',
      createMetric('INP', {
        inputDelay: 3,
        interactionTarget: 'button.submit',
        interactionTime: 100,
        interactionType: 'pointer',
        loadState: 'complete',
        presentationDelay: 5,
        processedEventEntries: [{ entryType: 'event' }],
        processingDuration: 4,
      })
    )
    report(
      'CLS',
      createMetric('CLS', {
        largestShiftEntry: { entryType: 'layout-shift' },
        largestShiftTarget: 'main article',
        largestShiftTime: 200,
        largestShiftValue: 0.12,
        loadState: 'complete',
      })
    )
    report('FCP', createMetric('FCP', { firstByteToFCP: 85, loadState: 'dom-interactive', timeToFirstByte: 42 }))
    report(
      'TTFB',
      createMetric('TTFB', {
        cacheDuration: 2,
        connectionDuration: 4,
        dnsDuration: 3,
        navigationEntry: { entryType: 'navigation' },
        requestDuration: 5,
        waitingDuration: 1,
      })
    )

    expect(mocks.spans[0]?.attributes).toMatchObject({
      'web_vital.inp.input_delay': 3,
      'web_vital.inp.interaction_time': 100,
      'web_vital.inp.interaction_type': 'pointer',
      'web_vital.inp.load_state': 'complete',
      'web_vital.inp.presentation_delay': 5,
      'web_vital.inp.processing_duration': 4,
      'web_vital.inp.target': 'button.submit',
    })
    expect(mocks.spans[1]?.attributes).toMatchObject({
      'web_vital.cls.largest_shift_target': 'main article',
      'web_vital.cls.largest_shift_time': 200,
      'web_vital.cls.largest_shift_value': 0.12,
      'web_vital.cls.load_state': 'complete',
    })
    expect(mocks.spans[2]?.attributes).toMatchObject({
      'web_vital.fcp.first_byte_to_fcp': 85,
      'web_vital.fcp.load_state': 'dom-interactive',
      'web_vital.fcp.time_to_first_byte': 42,
    })
    expect(mocks.spans[3]?.attributes).toMatchObject({
      'web_vital.ttfb.cache_duration': 2,
      'web_vital.ttfb.connection_duration': 4,
      'web_vital.ttfb.dns_duration': 3,
      'web_vital.ttfb.request_duration': 5,
      'web_vital.ttfb.waiting_duration': 1,
    })
    for (const span of mocks.spans) {
      expect(Object.values(span.attributes).every((value) => ['boolean', 'number', 'string'].includes(typeof value))).toBe(true)
    }
  })

  it('skips undefined attribution values', async () => {
    await startWebVitals()

    report(
      'LCP',
      createMetric('LCP', {
        elementRenderDelay: undefined,
        resourceLoadDelay: 10,
        resourceLoadDuration: 20,
        target: undefined,
        timeToFirstByte: 40,
        url: undefined,
      })
    )

    expect(mocks.spans[0]?.attributes).not.toHaveProperty('web_vital.lcp.element')
    expect(mocks.spans[0]?.attributes).not.toHaveProperty('web_vital.lcp.element_render_delay')
    expect(mocks.spans[0]?.attributes).not.toHaveProperty('web_vital.lcp.target')
    expect(mocks.spans[0]?.attributes).not.toHaveProperty('web_vital.lcp.url')
  })

  it('reports callback errors through diagnostics', async () => {
    mocks.startSpanErrorMessage = 'cannot start span'
    await startWebVitals()

    expect(() => {
      report('TTFB', createMetric('TTFB', { waitingDuration: 1 }))
    }).not.toThrow()

    expect(mocks.diagErrors).toHaveLength(1)
    expect(mocks.diagErrors[0]?.[0]).toBe('logfire-browser: failed to report Web Vital')
    expect(mocks.diagErrors[0]?.[1]).toBeInstanceOf(Error)
    expect((mocks.diagErrors[0]?.[1] as Error | undefined)?.message).toBe('cannot start span')
  })

  it('reports metric recorder errors through diagnostics without affecting spans', async () => {
    const metricRecorder = {
      record: vi.fn<(metric: unknown) => void>(() => {
        throw new Error('metric recorder failed')
      }),
      shutdown: vi.fn<() => void>(),
    }
    await startWebVitals({ metricRecorder })

    expect(() => {
      report('TTFB', createMetric('TTFB', { waitingDuration: 1 }))
    }).not.toThrow()

    expect(mocks.spans).toHaveLength(1)
    expect(mocks.diagErrors).toHaveLength(1)
    expect(mocks.diagErrors[0]?.[0]).toBe('logfire-browser: failed to report Web Vital metric')
    expect((mocks.diagErrors[0]?.[1] as Error | undefined)?.message).toBe('metric recorder failed')
  })
})
