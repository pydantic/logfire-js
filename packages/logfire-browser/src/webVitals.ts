import type { Attributes, Tracer } from '@opentelemetry/api'
import { diag } from '@opentelemetry/api'
import type {
  AttributionReportOpts,
  INPAttributionReportOpts,
  MetricWithAttribution,
  onCLS,
  onFCP,
  onINP,
  onLCP,
  onTTFB,
} from 'web-vitals/attribution'

import type { BrowserWebVitalsMetricOptions, BrowserWebVitalsMetricRecorder } from './browserMetrics'

export interface BrowserWebVitalsOptions {
  /**
   * Report metric changes instead of only final reportable values.
   * Defaults to false.
   */
  reportAllChanges?: boolean
  /**
   * Customize how DOM targets are stringified by `web-vitals/attribution`.
   */
  generateTarget?: (element: Node | null) => string | undefined
  /**
   * Whether INP attribution should include processed event entries internally.
   * Defaults to false to reduce memory pressure; entries are not exported as
   * span attributes either way.
   */
  includeProcessedEventEntries?: boolean
  /**
   * Emit native OTel metrics in parallel with spans. Requires configured
   * browser metrics transport.
   */
  metrics?: boolean | BrowserWebVitalsMetricOptions
}

export interface BrowserWebVitalsHandle {
  shutdown: () => Promise<void>
}

interface WebVitalsAttributionModule {
  onCLS: typeof onCLS
  onFCP: typeof onFCP
  onINP: typeof onINP
  onLCP: typeof onLCP
  onTTFB: typeof onTTFB
}

interface BrowserWebVitalsStartOptions extends BrowserWebVitalsOptions {
  metricRecorder?: BrowserWebVitalsMetricRecorder
  tracer: Tracer
}

let startupPromise: Promise<void> | undefined
let currentMetricRecorder: BrowserWebVitalsMetricRecorder | undefined
let currentTracer: Tracer | undefined
let registeredObserverOptions: ObserverOptions | undefined
let observerOptionsDuringStartup: ObserverOptions | undefined
const registeredWebVitals = new Set<WebVitalName>()

type WebVitalName = 'CLS' | 'FCP' | 'INP' | 'LCP' | 'TTFB'

interface ObserverOptions {
  generateTarget: BrowserWebVitalsOptions['generateTarget']
  includeProcessedEventEntries: boolean
  reportAllChanges: boolean | undefined
}

interface ReportOptionSource {
  generateTarget?: BrowserWebVitalsOptions['generateTarget']
  includeProcessedEventEntries?: boolean | undefined
  reportAllChanges?: boolean | undefined
}

function createHandle(metricRecorder: BrowserWebVitalsMetricRecorder | undefined, tracer: Tracer): BrowserWebVitalsHandle {
  let shutdownCalled = false
  return {
    async shutdown() {
      if (shutdownCalled) {
        return Promise.resolve()
      }
      shutdownCalled = true
      metricRecorder?.shutdown()
      if (currentMetricRecorder === metricRecorder) {
        currentMetricRecorder = undefined
      }
      if (currentTracer === tracer) {
        currentTracer = undefined
      }
      return Promise.resolve()
    },
  }
}

function setPrimitiveAttribute(attributes: Attributes, key: string, value: unknown): void {
  if (typeof value === 'string' || typeof value === 'boolean') {
    attributes[key] = value
    return
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    attributes[key] = value
  }
}

function createBaseReportOptions(options: ReportOptionSource = {}): AttributionReportOpts {
  const reportOptions: AttributionReportOpts = {}
  if (options.reportAllChanges !== undefined) {
    reportOptions.reportAllChanges = options.reportAllChanges
  }
  if (options.generateTarget !== undefined) {
    reportOptions.generateTarget = options.generateTarget
  }
  return reportOptions
}

function createInpReportOptions(options: ReportOptionSource = {}): INPAttributionReportOpts {
  return {
    ...createBaseReportOptions(options),
    includeProcessedEventEntries: options.includeProcessedEventEntries ?? false,
  }
}

function createBaseAttributes(metric: MetricWithAttribution): Attributes {
  const attributes: Attributes = {}
  setPrimitiveAttribute(attributes, 'web_vital.name', metric.name)
  setPrimitiveAttribute(attributes, 'web_vital.value', metric.value)
  setPrimitiveAttribute(attributes, 'web_vital.delta', metric.delta)
  setPrimitiveAttribute(attributes, 'web_vital.id', metric.id)
  setPrimitiveAttribute(attributes, 'web_vital.rating', metric.rating)
  setPrimitiveAttribute(attributes, 'web_vital.navigation_type', metric.navigationType)
  return attributes
}

function createMetricAttributes(metric: MetricWithAttribution): Attributes {
  const attributes = createBaseAttributes(metric)

  switch (metric.name) {
    case 'LCP': {
      const { attribution } = metric
      setPrimitiveAttribute(attributes, 'web_vital.lcp.target', attribution.target)
      setPrimitiveAttribute(attributes, 'web_vital.lcp.element', attribution.target)
      setPrimitiveAttribute(attributes, 'web_vital.lcp.url', attribution.url)
      setPrimitiveAttribute(attributes, 'web_vital.lcp.time_to_first_byte', attribution.timeToFirstByte)
      setPrimitiveAttribute(attributes, 'web_vital.lcp.resource_load_delay', attribution.resourceLoadDelay)
      setPrimitiveAttribute(attributes, 'web_vital.lcp.resource_load_duration', attribution.resourceLoadDuration)
      setPrimitiveAttribute(attributes, 'web_vital.lcp.element_render_delay', attribution.elementRenderDelay)
      break
    }
    case 'INP': {
      const { attribution } = metric
      setPrimitiveAttribute(attributes, 'web_vital.inp.target', attribution.interactionTarget)
      setPrimitiveAttribute(attributes, 'web_vital.inp.interaction_type', attribution.interactionType)
      setPrimitiveAttribute(attributes, 'web_vital.inp.interaction_time', attribution.interactionTime)
      setPrimitiveAttribute(attributes, 'web_vital.inp.input_delay', attribution.inputDelay)
      setPrimitiveAttribute(attributes, 'web_vital.inp.processing_duration', attribution.processingDuration)
      setPrimitiveAttribute(attributes, 'web_vital.inp.presentation_delay', attribution.presentationDelay)
      setPrimitiveAttribute(attributes, 'web_vital.inp.load_state', attribution.loadState)
      break
    }
    case 'CLS': {
      const { attribution } = metric
      setPrimitiveAttribute(attributes, 'web_vital.cls.largest_shift_target', attribution.largestShiftTarget)
      setPrimitiveAttribute(attributes, 'web_vital.cls.largest_shift_time', attribution.largestShiftTime)
      setPrimitiveAttribute(attributes, 'web_vital.cls.largest_shift_value', attribution.largestShiftValue)
      setPrimitiveAttribute(attributes, 'web_vital.cls.load_state', attribution.loadState)
      break
    }
    case 'FCP': {
      const { attribution } = metric
      setPrimitiveAttribute(attributes, 'web_vital.fcp.time_to_first_byte', attribution.timeToFirstByte)
      setPrimitiveAttribute(attributes, 'web_vital.fcp.first_byte_to_fcp', attribution.firstByteToFCP)
      setPrimitiveAttribute(attributes, 'web_vital.fcp.load_state', attribution.loadState)
      break
    }
    case 'TTFB': {
      const { attribution } = metric
      setPrimitiveAttribute(attributes, 'web_vital.ttfb.waiting_duration', attribution.waitingDuration)
      setPrimitiveAttribute(attributes, 'web_vital.ttfb.cache_duration', attribution.cacheDuration)
      setPrimitiveAttribute(attributes, 'web_vital.ttfb.dns_duration', attribution.dnsDuration)
      setPrimitiveAttribute(attributes, 'web_vital.ttfb.connection_duration', attribution.connectionDuration)
      setPrimitiveAttribute(attributes, 'web_vital.ttfb.request_duration', attribution.requestDuration)
      break
    }
    default:
      break
  }

  return attributes
}

function reportWebVitalSpan(metric: MetricWithAttribution, tracer: Tracer | undefined): void {
  if (tracer === undefined) {
    diag.error('logfire-browser: failed to report Web Vital', new Error('missing Web Vitals tracer'))
    return
  }

  try {
    const span = tracer.startSpan(`web_vital.${metric.name.toLowerCase()}`)
    try {
      span.setAttributes(createMetricAttributes(metric))
    } finally {
      span.end()
    }
  } catch (error) {
    diag.error('logfire-browser: failed to report Web Vital', error)
  }
}

function reportWebVitalMetric(metric: MetricWithAttribution, metricRecorder: BrowserWebVitalsMetricRecorder | undefined): void {
  if (metricRecorder === undefined) {
    return
  }

  try {
    metricRecorder.record(metric)
  } catch (error) {
    diag.error('logfire-browser: failed to report Web Vital metric', error)
  }
}

function reportWebVital(
  metric: MetricWithAttribution,
  metricRecorder: BrowserWebVitalsMetricRecorder | undefined,
  tracer: Tracer | undefined
): void {
  reportWebVitalSpan(metric, tracer)
  reportWebVitalMetric(metric, metricRecorder)
}

function registerWebVitals(webVitals: WebVitalsAttributionModule, requestedOptions: BrowserWebVitalsStartOptions): void {
  const options = (observerOptionsDuringStartup ??= normalizeObserverOptions(requestedOptions))
  const reportOptions = createBaseReportOptions(options)
  const report = (metric: MetricWithAttribution) => {
    if (registeredObserverOptions === undefined) {
      return
    }
    reportWebVital(metric, currentMetricRecorder, currentTracer)
  }
  const registrations = [
    ['LCP', webVitals.onLCP, reportOptions],
    ['INP', webVitals.onINP, createInpReportOptions(options)],
    ['CLS', webVitals.onCLS, reportOptions],
    ['FCP', webVitals.onFCP, reportOptions],
    ['TTFB', webVitals.onTTFB, reportOptions],
  ] as const
  for (const [name, register, registrationOptions] of registrations) {
    if (registeredWebVitals.has(name)) {
      continue
    }
    register(report, registrationOptions as never)
    registeredWebVitals.add(name)
  }
  registeredObserverOptions = options
}

export async function startBrowserWebVitals(options: BrowserWebVitalsStartOptions): Promise<BrowserWebVitalsHandle> {
  if (options.metricRecorder !== undefined) {
    currentMetricRecorder = options.metricRecorder
  }
  currentTracer = options.tracer

  const observerOptions = normalizeObserverOptions(options)
  if (startupPromise === undefined) {
    const startup = import('web-vitals/attribution')
      .then((webVitals) => {
        registerWebVitals(webVitals, options)
      })
      .catch((error: unknown) => {
        if (startupPromise === startup) {
          startupPromise = undefined
        }
        if (registeredWebVitals.size === 0) {
          observerOptionsDuringStartup = undefined
        }
        throw error
      })
    startupPromise = startup
  }

  try {
    await startupPromise
  } catch (error) {
    options.metricRecorder?.shutdown()
    if (currentMetricRecorder === options.metricRecorder) {
      currentMetricRecorder = undefined
    }
    if (currentTracer === options.tracer) {
      currentTracer = undefined
    }
    throw error
  }
  if (registeredObserverOptions !== undefined && !sameObserverOptions(registeredObserverOptions, observerOptions)) {
    diag.warn('logfire-browser: Web Vitals observer options are fixed by the first successful startup; ignoring changed options')
  }
  return createHandle(options.metricRecorder, options.tracer)
}

export function resetBrowserWebVitalsForTests(): void {
  startupPromise = undefined
  currentMetricRecorder = undefined
  currentTracer = undefined
  registeredObserverOptions = undefined
  observerOptionsDuringStartup = undefined
  registeredWebVitals.clear()
}

function normalizeObserverOptions(options: BrowserWebVitalsOptions): ObserverOptions {
  return {
    generateTarget: options.generateTarget,
    includeProcessedEventEntries: options.includeProcessedEventEntries ?? false,
    reportAllChanges: options.reportAllChanges,
  }
}

function sameObserverOptions(left: ObserverOptions, right: ObserverOptions): boolean {
  return (
    left.generateTarget === right.generateTarget &&
    left.includeProcessedEventEntries === right.includeProcessedEventEntries &&
    (left.reportAllChanges ?? false) === (right.reportAllChanges ?? false)
  )
}
