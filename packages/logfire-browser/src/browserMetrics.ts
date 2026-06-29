import type { Attributes, Histogram } from '@opentelemetry/api'
import { diag } from '@opentelemetry/api'
import type { OTLPMetricExporterOptions } from '@opentelemetry/exporter-metrics-otlp-http'
import type { Resource } from '@opentelemetry/resources'
import type { MeterProvider, MetricReader, PeriodicExportingMetricReaderOptions } from '@opentelemetry/sdk-metrics'
import type { MetricWithAttribution } from 'web-vitals/attribution'

export interface BrowserMetricsOptions {
  /**
   * Browser-safe OTLP metrics proxy URL, e.g. `/logfire-proxy/v1/metrics`.
   */
  metricUrl: string
  /**
   * Dynamic headers for the metric exporter. Browser apps should normally
   * authenticate through their backend proxy, not with a Logfire write token in
   * client code.
   */
  metricExporterHeaders?: () => Record<string, string> | Promise<Record<string, string>>
  /**
   * Additional OTLP metric exporter options. `url` and `headers` are owned by
   * the browser Logfire metrics transport configuration.
   */
  metricExporterConfig?: Omit<OTLPMetricExporterOptions, 'url' | 'headers'>
  /**
   * Periodic reader settings such as exportIntervalMillis and
   * exportTimeoutMillis.
   */
  metricReaderConfig?: Omit<PeriodicExportingMetricReaderOptions, 'exporter'>
  /**
   * Advanced extension point for callers that already own a metric reader.
   */
  metricReaders?: MetricReader[]
}

export interface BrowserWebVitalsMetricOptions {
  /**
   * Add sanitized data point attributes. Keep this low-cardinality.
   */
  attributes?: false | ((metric: MetricWithAttribution) => Attributes)
}

export interface BrowserWebVitalsMetricRecorder {
  record: (metric: MetricWithAttribution) => void
  shutdown: () => void
}

export interface BrowserWebVitalsMetricRecorderOptions extends BrowserWebVitalsMetricOptions {
  defaultAttributes?: (metric: MetricWithAttribution) => Attributes
}

export interface BrowserMetricsRuntime {
  createWebVitalsMetricRecorder: (options?: BrowserWebVitalsMetricRecorderOptions) => BrowserWebVitalsMetricRecorder
  forceFlush: () => Promise<void>
  shutdown: () => Promise<void>
}

interface WebVitalMetricInstrument {
  boundaries: number[]
  description: string
  name: string
  unit: '1' | 'ms'
}

type WebVitalName = 'CLS' | 'FCP' | 'INP' | 'LCP' | 'TTFB'

const WEB_VITAL_METRIC_INSTRUMENTS: Record<WebVitalName, WebVitalMetricInstrument> = {
  CLS: {
    boundaries: [0.01, 0.05, 0.1, 0.15, 0.25, 0.5, 1],
    description: 'Cumulative Layout Shift score recorded in browser sessions.',
    name: 'logfire.browser.web_vital.cls',
    unit: '1',
  },
  FCP: {
    boundaries: [500, 1000, 1500, 1800, 2500, 3000, 4000, 6000],
    description: 'First Contentful Paint duration recorded in browser sessions.',
    name: 'logfire.browser.web_vital.fcp',
    unit: 'ms',
  },
  INP: {
    boundaries: [50, 100, 150, 200, 300, 500, 800, 1000, 2000],
    description: 'Interaction to Next Paint duration recorded in browser sessions.',
    name: 'logfire.browser.web_vital.inp',
    unit: 'ms',
  },
  LCP: {
    boundaries: [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 5000, 8000, 10000],
    description: 'Largest Contentful Paint duration recorded in browser sessions.',
    name: 'logfire.browser.web_vital.lcp',
    unit: 'ms',
  },
  TTFB: {
    boundaries: [100, 300, 500, 800, 1200, 1800, 2500, 4000],
    description: 'Time to First Byte duration recorded in browser sessions.',
    name: 'logfire.browser.web_vital.ttfb',
    unit: 'ms',
  },
}

const DISALLOWED_WEB_VITAL_METRIC_ATTRIBUTES = new Set([
  'browser.session.id',
  'session.id',
  'url.full',
  'web_vital.delta',
  'web_vital.id',
  'web_vital.value',
])

const DEFAULT_METRIC_READER_CONFIG: Omit<PeriodicExportingMetricReaderOptions, 'exporter'> = {
  exportIntervalMillis: 60_000,
  exportTimeoutMillis: 10_000,
}

function isWebVitalName(name: string): name is WebVitalName {
  return name === 'CLS' || name === 'FCP' || name === 'INP' || name === 'LCP' || name === 'TTFB'
}

function isDisallowedWebVitalMetricAttribute(key: string): boolean {
  return (
    DISALLOWED_WEB_VITAL_METRIC_ATTRIBUTES.has(key) ||
    key.startsWith('web_vital.cls.') ||
    key.startsWith('web_vital.fcp.') ||
    key.startsWith('web_vital.inp.') ||
    key.startsWith('web_vital.lcp.') ||
    key.startsWith('web_vital.ttfb.')
  )
}

function setPrimitiveAttribute(attributes: Attributes, key: string, value: unknown): void {
  if (isDisallowedWebVitalMetricAttribute(key)) {
    return
  }

  if (typeof value === 'string' || typeof value === 'boolean') {
    attributes[key] = value
    return
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    attributes[key] = value
  }
}

function copyPrimitiveAttributes(target: Attributes, source: Attributes | undefined): void {
  if (source === undefined) {
    return
  }

  for (const [key, value] of Object.entries(source)) {
    setPrimitiveAttribute(target, key, value)
  }
}

function createDefaultWebVitalMetricAttributes(metric: MetricWithAttribution): Attributes {
  const attributes: Attributes = {}
  setPrimitiveAttribute(attributes, 'web_vital.name', metric.name)
  setPrimitiveAttribute(attributes, 'web_vital.rating', metric.rating)
  return attributes
}

function createWebVitalMetricHistograms(meterProvider: MeterProvider): Record<WebVitalName, Histogram> {
  const meter = meterProvider.getMeter('logfire-browser-web-vitals')
  return {
    CLS: meter.createHistogram(WEB_VITAL_METRIC_INSTRUMENTS.CLS.name, {
      advice: { explicitBucketBoundaries: WEB_VITAL_METRIC_INSTRUMENTS.CLS.boundaries },
      description: WEB_VITAL_METRIC_INSTRUMENTS.CLS.description,
      unit: WEB_VITAL_METRIC_INSTRUMENTS.CLS.unit,
    }),
    FCP: meter.createHistogram(WEB_VITAL_METRIC_INSTRUMENTS.FCP.name, {
      advice: { explicitBucketBoundaries: WEB_VITAL_METRIC_INSTRUMENTS.FCP.boundaries },
      description: WEB_VITAL_METRIC_INSTRUMENTS.FCP.description,
      unit: WEB_VITAL_METRIC_INSTRUMENTS.FCP.unit,
    }),
    INP: meter.createHistogram(WEB_VITAL_METRIC_INSTRUMENTS.INP.name, {
      advice: { explicitBucketBoundaries: WEB_VITAL_METRIC_INSTRUMENTS.INP.boundaries },
      description: WEB_VITAL_METRIC_INSTRUMENTS.INP.description,
      unit: WEB_VITAL_METRIC_INSTRUMENTS.INP.unit,
    }),
    LCP: meter.createHistogram(WEB_VITAL_METRIC_INSTRUMENTS.LCP.name, {
      advice: { explicitBucketBoundaries: WEB_VITAL_METRIC_INSTRUMENTS.LCP.boundaries },
      description: WEB_VITAL_METRIC_INSTRUMENTS.LCP.description,
      unit: WEB_VITAL_METRIC_INSTRUMENTS.LCP.unit,
    }),
    TTFB: meter.createHistogram(WEB_VITAL_METRIC_INSTRUMENTS.TTFB.name, {
      advice: { explicitBucketBoundaries: WEB_VITAL_METRIC_INSTRUMENTS.TTFB.boundaries },
      description: WEB_VITAL_METRIC_INSTRUMENTS.TTFB.description,
      unit: WEB_VITAL_METRIC_INSTRUMENTS.TTFB.unit,
    }),
  }
}

function createWebVitalsMetricRecorder(
  histograms: Record<WebVitalName, Histogram>,
  options: BrowserWebVitalsMetricRecorderOptions = {}
): BrowserWebVitalsMetricRecorder {
  let active = true

  return {
    record(metric) {
      if (!active || !isWebVitalName(metric.name)) {
        return
      }

      try {
        const attributes = createDefaultWebVitalMetricAttributes(metric)
        copyPrimitiveAttributes(attributes, options.defaultAttributes?.(metric))
        if (options.attributes !== false) {
          copyPrimitiveAttributes(attributes, options.attributes?.(metric))
        }
        histograms[metric.name].record(metric.value, attributes)
      } catch (error) {
        diag.error('logfire-browser: failed to record Web Vital metric', error)
      }
    },
    shutdown() {
      active = false
    },
  }
}

export async function startBrowserMetrics(options: BrowserMetricsOptions, resource: Resource): Promise<BrowserMetricsRuntime> {
  const [{ MeterProvider, PeriodicExportingMetricReader }, { OTLPMetricExporter }] = await Promise.all([
    import('@opentelemetry/sdk-metrics'),
    import('@opentelemetry/exporter-metrics-otlp-http'),
  ])

  const exporter = new OTLPMetricExporter({
    ...options.metricExporterConfig,
    headers: options.metricExporterHeaders === undefined ? undefined : async () => options.metricExporterHeaders?.() ?? {},
    url: options.metricUrl,
  } as OTLPMetricExporterOptions)
  const defaultReader = new PeriodicExportingMetricReader({
    ...DEFAULT_METRIC_READER_CONFIG,
    ...options.metricReaderConfig,
    exporter,
  } as PeriodicExportingMetricReaderOptions)
  const metricReaders = [defaultReader, ...(options.metricReaders ?? [])]
  const meterProvider = new MeterProvider({
    readers: metricReaders,
    resource,
  })
  const webVitalHistograms = createWebVitalMetricHistograms(meterProvider)
  let shutdownPromise: Promise<void> | undefined

  return {
    createWebVitalsMetricRecorder(options) {
      return createWebVitalsMetricRecorder(webVitalHistograms, options)
    },
    async forceFlush() {
      if (shutdownPromise !== undefined) {
        return shutdownPromise
      }
      await meterProvider.forceFlush()
    },
    async shutdown() {
      shutdownPromise ??= meterProvider.shutdown()
      return shutdownPromise
    },
  }
}
