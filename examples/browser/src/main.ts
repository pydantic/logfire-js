import { getWebAutoInstrumentations } from '@opentelemetry/auto-instrumentations-web'
import * as logfire from '@pydantic/logfire-browser'

logfire.configure({
  traceUrl: 'http://localhost:8989/client-traces',
  metrics: {
    metricUrl: 'http://localhost:8989/client-metrics',
  },
  serviceName: 'browser-rum-smoke',
  serviceVersion: '0.1.0',
  rum: {
    session: {
      urlAttributes: (url) => ({
        full: `${url.origin}${url.pathname}`,
        path: url.pathname,
      }),
    },
    webVitals: {
      metrics: true,
      reportAllChanges: true,
    },
  },
  // The instrumentations to use
  // https://www.npmjs.com/package/@opentelemetry/auto-instrumentations-web - for more options and configuration
  instrumentations: [
    getWebAutoInstrumentations({
      '@opentelemetry/instrumentation-document-load': { enabled: true },
      '@opentelemetry/instrumentation-user-interaction': {
        eventNames: ['click'],
      },
    }),
  ],
  // This outputs details about the generated spans in the browser console, use only in development and for troubleshooting.
  diagLogLevel: logfire.DiagLogLevel.ALL,
  batchSpanProcessorConfig: {
    maxExportBatchSize: 10,
  },
})

const statusElement = document.querySelector<HTMLElement>('#status')
const sessionElement = document.querySelector<HTMLElement>('#session-id')
const appElement = document.querySelector<HTMLElement>('#app')

function setStatus(status: string): void {
  if (statusElement !== null) {
    statusElement.textContent = status
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

sessionElement?.replaceChildren(logfire.getBrowserSessionId() ?? 'unavailable')

document.querySelector<HTMLButtonElement>('[data-action="fetch"]')?.addEventListener('click', () => {
  setStatus('fetching')
  logfire.info('Browser RUM smoke fetch clicked')
  void logfire.span('browser rum smoke fetch', {
    attributes: {
      'example.action': 'fetch',
    },
    callback: async () => {
      const response = await fetch('https://jsonplaceholder.typicode.com/posts/1')
      setStatus(`fetched ${response.status}`)
      return response
    },
  })
})

document.querySelector<HTMLButtonElement>('[data-action="work"]')?.addEventListener('click', () => {
  setStatus('working')
  void logfire.span('browser rum smoke work', {
    attributes: {
      'example.action': 'work',
    },
    callback: async () => {
      await delay(500)
      logfire.info('Browser RUM smoke work completed')
      setStatus('work complete')
    },
  })
})

document.querySelector<HTMLButtonElement>('[data-action="shift"]')?.addEventListener('click', () => {
  const banner = document.createElement('section')
  banner.className = 'shift-banner'
  banner.textContent = `Layout shift generated at ${new Date().toLocaleTimeString()}`
  appElement?.prepend(banner)
  logfire.info('Browser RUM smoke layout shift triggered', {
    'example.action': 'shift',
  })
  setStatus('layout shift generated')
})

document.querySelector<HTMLButtonElement>('[data-action="error"]')?.addEventListener('click', () => {
  const error = new Error('Browser RUM smoke reported error')
  logfire.reportError('Browser RUM smoke reported error', error, {
    'example.action': 'error',
  })
  setStatus('error reported')
})
