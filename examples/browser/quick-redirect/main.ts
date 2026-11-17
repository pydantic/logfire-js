import * as logfire from '@pydantic/logfire-browser'

const params = new URLSearchParams(location.search)
const run = params.get('run') ?? crypto.randomUUID()
const destination = params.has('destination')
const expected: string[] = []
const status = document.querySelector('[role="status"]')!
const traceUrl = `http://127.0.0.1:4195/collector/${run}`
// Warm the CORS preflight cache while the source document is alive.
const collectorReady = fetch(traceUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ resourceSpans: [] }),
}).then((response) => response.json())

performance.setResourceTimingBufferSize(1_000)
logfire.configure({
  serviceName: 'quick-redirect-example',
  traceUrl,
  ...(params.get('persistence') === 'default' ? {} : { tracePersistence: params.get('persistence') === 'off' ? false : {} }),
  // The throttled control must finish before an exporter timeout can cancel it.
  traceExporterConfig: { timeoutMillis: 30_000 },
  autoInstrumentations: {
    '@opentelemetry/instrumentation-fetch': { enabled: false },
    '@opentelemetry/instrumentation-xml-http-request': { enabled: false },
    '@opentelemetry/instrumentation-user-interaction': { enabled: false },
    '@opentelemetry/instrumentation-document-load': {
      applyCustomAttributesOnSpan: {
        resourceFetch(span, resource) {
          if (new URL(resource.name).pathname.startsWith('/resource/')) {
            // Model the issue's large resource records without relying on Vite's module count.
            span.setAttribute('example.resource_detail', 'resource timing detail '.repeat(65))
            span.setAttribute('example.resource', true)
          }
        },
      },
    },
  },
  spanProcessors: [
    {
      onStart() {},
      onEnd(span) {
        if (span.attributes['example.resource'] === true) {
          expected.push(span.spanContext().spanId)
        }
        if (span.name === 'documentLoad' && !destination) {
          sessionStorage.setItem(`quick-redirect:${run}`, JSON.stringify(expected))
        }
      },
      async forceFlush() {},
      async shutdown() {},
    },
  ],
  // Keep the resource burst queued until the hide flush (or the control's explicit flush).
  batchSpanProcessorConfig: { scheduledDelayMillis: 60_000, maxExportBatchSize: 512 },
})

if (destination) {
  status.textContent = 'Destination loaded'
} else {
  for (let index = 0; index < 250; index += 1) {
    const image = document.createElement('img')
    image.src = `/resource/${index}.svg`
    image.alt = ''
    document.querySelector('#resources')!.append(image)
  }
  window.addEventListener(
    'load',
    async () => {
      await collectorReady
      setTimeout(() => {
        if (params.get('mode') === 'stay' || params.get('mode') === 'iframe') {
          status.textContent = 'Exporting without navigation'
          if (params.get('mode') === 'iframe') {
            const frame = document.createElement('iframe')
            frame.src = `/?run=${run}&destination=1`
            document.body.append(frame)
          }
          void logfire.forceFlush().then(() => {
            status.textContent = 'Export complete'
          })
        } else {
          const navigate = () => {
            location.assign(`/?run=${run}&destination=1`)
          }
          if (params.get('mode') === 'in-flight') {
            // The hide flush cannot see spans already removed from the batch processor's queue.
            void logfire.forceFlush().catch(() => undefined)
            setTimeout(navigate, 150)
          } else {
            navigate()
          }
        }
      }, 150)
    },
    { once: true }
  )
}
