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
import type { BrowserSessionManager } from './browserSession'
import { normalizeScriptEntry } from './scriptAttributes'

import { setOwn } from './ownRecord'

const LOGFIRE_SPAN_TYPE_KEY = 'logfire.span_type'
const ATTR_LOGFIRE_PAGE_ROUTE = 'logfire.page.route'
const ATTR_LOGFIRE_PAGE_URL_FULL = 'logfire.page.url.full'
const ATTR_LOGFIRE_PAGE_URL_PATH = 'logfire.page.url.path'

export interface BrowserWebVitalsOptions {
  /**
   * Report metric changes instead of only final reportable values.
   * Defaults to false.
   */
  reportAllChanges?: boolean
  /**
   * Report Web Vitals separately for supported browser-detected soft
   * navigations. Defaults to false. Currently supported in Chromium 151+.
   */
  reportSoftNavs?: boolean
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
  sessionManager?: BrowserSessionManager
  tracer: Tracer
}

let startupPromise: Promise<void> | undefined
let currentMetricRecorder: BrowserWebVitalsMetricRecorder | undefined
let currentTracer: Tracer | undefined
let currentOwner: { active: boolean } | undefined
let currentSessionManager: BrowserSessionManager | undefined
let registeredObserverOptions: ObserverOptions | undefined
let observerOptionsDuringStartup: ObserverOptions | undefined
const registeredWebVitals = new Set<WebVitalName>()

type WebVitalName = 'CLS' | 'FCP' | 'INP' | 'LCP' | 'TTFB'

interface ObserverOptions {
  generateTarget: BrowserWebVitalsOptions['generateTarget']
  includeProcessedEventEntries: boolean
  reportAllChanges: boolean | undefined
  reportSoftNavs: boolean | undefined
}

interface ReportOptionSource {
  generateTarget?: BrowserWebVitalsOptions['generateTarget']
  includeProcessedEventEntries?: boolean | undefined
  reportAllChanges?: boolean | undefined
  reportSoftNavs?: boolean | undefined
}

function createHandle(
  metricRecorder: BrowserWebVitalsMetricRecorder | undefined,
  sessionManager: BrowserSessionManager | undefined,
  tracer: Tracer,
  owner: { active: boolean }
): BrowserWebVitalsHandle {
  let shutdownCalled = false
  return {
    async shutdown() {
      if (shutdownCalled) {
        return Promise.resolve()
      }
      shutdownCalled = true
      owner.active = false
      metricRecorder?.shutdown()
      if (currentMetricRecorder === metricRecorder) {
        currentMetricRecorder = undefined
      }
      if (currentTracer === tracer) {
        currentTracer = undefined
      }
      if (currentSessionManager === sessionManager) {
        currentSessionManager = undefined
      }
      if (currentOwner === owner) {
        currentOwner = undefined
      }
      return Promise.resolve()
    },
  }
}

function setPrimitiveAttribute(attributes: Attributes, key: string, value: unknown): void {
  if (typeof value === 'string' || typeof value === 'boolean') {
    setOwn(attributes, key, value)
    return
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    setOwn(attributes, key, value)
  }
}

function createBaseReportOptions(options: ReportOptionSource = {}): AttributionReportOpts {
  const reportOptions: AttributionReportOpts = {}
  if (options.reportAllChanges !== undefined) {
    reportOptions.reportAllChanges = options.reportAllChanges
  }
  if (options.reportSoftNavs !== undefined) {
    reportOptions.reportSoftNavs = options.reportSoftNavs
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
  const attributes: Attributes = { [LOGFIRE_SPAN_TYPE_KEY]: 'log' }
  setPrimitiveAttribute(attributes, 'web_vital.name', metric.name)
  setPrimitiveAttribute(attributes, 'web_vital.value', metric.value)
  setPrimitiveAttribute(attributes, 'web_vital.delta', metric.delta)
  setPrimitiveAttribute(attributes, 'web_vital.id', metric.id)
  setPrimitiveAttribute(attributes, 'web_vital.rating', metric.rating)
  setPrimitiveAttribute(attributes, 'web_vital.navigation_type', metric.navigationType)
  setPrimitiveAttribute(attributes, 'web_vital.navigation_id', metric.navigationId)
  setPrimitiveAttribute(attributes, 'web_vital.navigation_interaction_id', metric.navigationInteractionId)
  setPrimitiveAttribute(attributes, 'web_vital.navigation_start_time', metric.navigationStartTime)
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
      const script = normalizeScriptEntry(attribution.longestScript?.entry)
      if (script !== undefined) {
        setPrimitiveAttribute(attributes, 'web_vital.inp.script.source_url', script.sourceUrl)
        setPrimitiveAttribute(attributes, 'web_vital.inp.script.function_name', script.functionName)
        setPrimitiveAttribute(attributes, 'web_vital.inp.script.invoker', script.invoker)
        setPrimitiveAttribute(attributes, 'web_vital.inp.script.duration', script.duration)
      }
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

function getCurrentUrl(): URL | undefined {
  const maybeGlobal = globalThis as {
    location?: { href?: string }
    window?: { location?: { href?: string } }
  }

  try {
    const href = (maybeGlobal.location ?? maybeGlobal.window?.location)?.href
    return href === undefined || href === '' ? undefined : new URL(href)
  } catch {
    return undefined
  }
}

function createPageContextAttributes(metric: MetricWithAttribution, sessionManager: BrowserSessionManager | undefined): Attributes {
  const attributes: Attributes = {}
  if (sessionManager === undefined) {
    return attributes
  }

  const isSoftNavigation = metric.navigationType === 'soft-navigation'
  let navigationUrl: URL | undefined
  if (metric.navigationURL !== undefined) {
    try {
      navigationUrl = new URL(metric.navigationURL)
    } catch {
      navigationUrl = undefined
    }
  }
  const url = navigationUrl ?? (isSoftNavigation ? undefined : getCurrentUrl())
  if (url !== undefined) {
    try {
      const urlAttributes = sessionManager.getUrlAttributes(url)
      setPrimitiveAttribute(attributes, ATTR_LOGFIRE_PAGE_URL_FULL, urlAttributes?.full)
      setPrimitiveAttribute(attributes, ATTR_LOGFIRE_PAGE_URL_PATH, urlAttributes?.path)
    } catch {
      // A consumer URL callback must not suppress the Web Vital report.
    }
  }

  if (!isSoftNavigation && navigationUrl === undefined) {
    setPrimitiveAttribute(attributes, ATTR_LOGFIRE_PAGE_ROUTE, sessionManager.getRouteName())
  }
  return attributes
}

function reportWebVitalSpan(
  metric: MetricWithAttribution,
  sessionManager: BrowserSessionManager | undefined,
  tracer: Tracer | undefined
): void {
  if (tracer === undefined) {
    diag.error('logfire-browser: failed to report Web Vital', new Error('missing Web Vitals tracer'))
    return
  }

  try {
    const span = tracer.startSpan(`web_vital.${metric.name.toLowerCase()}`)
    try {
      span.setAttributes(createMetricAttributes(metric))
      span.setAttributes(createPageContextAttributes(metric, sessionManager))
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
    if (registeredObserverOptions?.reportSoftNavs === true) {
      metricRecorder.record(metric, { 'web_vital.navigation_type': metric.navigationType })
    } else {
      metricRecorder.record(metric)
    }
  } catch (error) {
    diag.error('logfire-browser: failed to report Web Vital metric', error)
  }
}

function reportWebVital(
  metric: MetricWithAttribution,
  metricRecorder: BrowserWebVitalsMetricRecorder | undefined,
  sessionManager: BrowserSessionManager | undefined,
  tracer: Tracer | undefined
): void {
  reportWebVitalSpan(metric, sessionManager, tracer)
  reportWebVitalMetric(metric, metricRecorder)
}

function registerWebVitals(webVitals: WebVitalsAttributionModule, requestedOptions: BrowserWebVitalsStartOptions): void {
  const options = (observerOptionsDuringStartup ??= normalizeObserverOptions(requestedOptions))
  const reportOptions = createBaseReportOptions(options)
  const report = (metric: MetricWithAttribution) => {
    if (registeredObserverOptions === undefined || currentOwner?.active !== true) {
      return
    }
    reportWebVital(metric, currentMetricRecorder, currentSessionManager, currentTracer)
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
  const owner = { active: true }
  if (options.metricRecorder !== undefined) {
    currentMetricRecorder = options.metricRecorder
  }
  currentTracer = options.tracer
  currentSessionManager = options.sessionManager
  currentOwner = owner

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
    owner.active = false
    options.metricRecorder?.shutdown()
    if (currentMetricRecorder === options.metricRecorder) {
      currentMetricRecorder = undefined
    }
    if (currentTracer === options.tracer) {
      currentTracer = undefined
    }
    if (currentSessionManager === options.sessionManager) {
      currentSessionManager = undefined
    }
    if (currentOwner === owner) {
      currentOwner = undefined
    }
    throw error
  }
  if (registeredObserverOptions !== undefined && !sameObserverOptions(registeredObserverOptions, observerOptions)) {
    diag.warn('logfire-browser: Web Vitals observer options are fixed by the first successful startup; ignoring changed options')
  }
  return createHandle(options.metricRecorder, options.sessionManager, options.tracer, owner)
}

export function resetBrowserWebVitalsForTests(): void {
  startupPromise = undefined
  currentMetricRecorder = undefined
  currentTracer = undefined
  currentOwner = undefined
  currentSessionManager = undefined
  registeredObserverOptions = undefined
  observerOptionsDuringStartup = undefined
  registeredWebVitals.clear()
}

function normalizeObserverOptions(options: BrowserWebVitalsOptions): ObserverOptions {
  return {
    generateTarget: options.generateTarget,
    includeProcessedEventEntries: options.includeProcessedEventEntries ?? false,
    reportAllChanges: options.reportAllChanges,
    reportSoftNavs: options.reportSoftNavs,
  }
}

function sameObserverOptions(left: ObserverOptions, right: ObserverOptions): boolean {
  return (
    left.generateTarget === right.generateTarget &&
    left.includeProcessedEventEntries === right.includeProcessedEventEntries &&
    (left.reportAllChanges ?? false) === (right.reportAllChanges ?? false) &&
    (left.reportSoftNavs ?? false) === (right.reportSoftNavs ?? false)
  )
}
