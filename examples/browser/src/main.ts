import * as logfire from '@pydantic/logfire-browser'

const proxyOrigin = developmentProxyOrigin(import.meta.env.VITE_LOGFIRE_PROXY_ORIGIN)
installR7UnhandledObserver(proxyOrigin)

logfire.configure({
  traceUrl: `${proxyOrigin}/client-traces`,
  metrics: {
    metricUrl: `${proxyOrigin}/client-metrics`,
  },
  serviceName: 'browser-rum-smoke',
  serviceVersion: '0.1.0',
  sessionReplay:
    import.meta.env['VITE_LOGFIRE_REPLAY'] === 'true'
      ? {
          load: () => import('lf-browser-recorder'),
          maskAllInputs: true,
          replayUrl: `${proxyOrigin}/client-replay`,
        }
      : false,
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
  // SDK-managed auto-instrumentations automatically exclude Logfire telemetry endpoints.
  autoInstrumentations: {
    '@opentelemetry/instrumentation-document-load': { enabled: true },
    '@opentelemetry/instrumentation-user-interaction': {
      eventNames: ['click'],
    },
  },
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

function developmentProxyOrigin(value: string | undefined): string {
  if (value === undefined || value === '') {
    return ''
  }
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.origin !== value) {
    throw new Error('VITE_LOGFIRE_PROXY_ORIGIN must be an http://127.0.0.1:<port> origin')
  }
  return value
}

function installR7UnhandledObserver(origin: string): void {
  if (origin === '') {
    return
  }
  window.__r7Unhandled = []
  window.addEventListener('unhandledrejection', (event) => {
    window.__r7Unhandled?.push(String(event.reason))
  })
}

sessionElement?.replaceChildren(logfire.getBrowserSessionId() ?? 'unavailable')

document.querySelector<HTMLButtonElement>('[data-action="fetch"]')?.addEventListener('click', () => {
  setStatus('fetching')
  logfire.info('Browser RUM smoke fetch clicked')
  void runFetchAction()
})

async function runFetchAction(): Promise<void> {
  try {
    await logfire.span('browser rum smoke fetch', {
      attributes: {
        'example.action': 'fetch',
      },
      callback: async () => {
        const response = await fetch(`${proxyOrigin}/api/post`)
        if (!response.ok) {
          throw new Error(`basic fetch failed with ${String(response.status)}`)
        }
        setStatus(`fetched ${response.status}`)
        return response
      },
    })
  } catch (error) {
    setStatus('fetch failed')
    logfire.reportError('Browser example fetch failed', error, {
      'example.action': 'fetch',
    })
  }
}

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
