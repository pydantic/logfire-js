import * as logfire from '@pydantic/logfire-browser'

interface CatalogProduct {
  name: string
  sku: string
  stock: number
}

interface CatalogResponse {
  products: CatalogProduct[]
  region: string
}

interface InventoryResponse {
  available: number
  checkedAt: string
  warehouse: string
}

interface CheckoutResponse {
  accepted: boolean
  orderId: string
  userId: string
}

const proxyOrigin = developmentProxyOrigin(import.meta.env.VITE_LOGFIRE_PROXY_ORIGIN)
installR7UnhandledObserver(proxyOrigin)
const traceUrl = `${proxyOrigin}/client-traces`
const metricUrl = `${proxyOrigin}/client-metrics`
const replayUrl = `${proxyOrigin}/client-replay`

logfire.configure({
  traceUrl,
  metrics: {
    metricUrl,
  },
  serviceName: 'browser-rum-replay-example',
  serviceVersion: '0.1.0',
  environment: 'local',
  resourceAttributes: {
    'example.name': 'browser-rum-replay',
  },
  sessionReplay: {
    load: () => import('lf-browser-recorder'),
    replayUrl,
    headers: () => ({
      'X-Logfire-Example': 'browser-rum-replay',
    }),
    sessionSampleRate: 1,
    onErrorSampleRate: 1,
    maskAllInputs: true,
    blockSelector: '[data-logfire-block]',
    captureConsole: true,
    captureNetwork: true,
    captureNavigation: true,
    distinctId: 'anonymous',
    getDistinctId: () => getUserId(),
    flushIntervalMs: 2_000,
  },
  rum: {
    session: {
      urlAttributes: (url) => ({
        full: `${url.origin}${routeTemplate(url.pathname)}`,
        path: routeTemplate(url.pathname),
      }),
    },
    webVitals: {
      reportAllChanges: true,
      metrics: {
        attributes: () => ({
          'app.route': routeTemplate(window.location.pathname),
          'app.view': currentView(),
        }),
      },
    },
  },
  autoInstrumentations: {
    '@opentelemetry/instrumentation-document-load': { enabled: true },
    '@opentelemetry/instrumentation-fetch': {
      enabled: true,
      clearTimingResources: true,
    },
    '@opentelemetry/instrumentation-user-interaction': {
      enabled: true,
      eventNames: ['click', 'change'],
    },
    '@opentelemetry/instrumentation-xml-http-request': { enabled: true },
  },
  diagLogLevel: import.meta.env.VITE_LOGFIRE_DIAG === 'true' ? logfire.DiagLogLevel.ALL : logfire.DiagLogLevel.ERROR,
  batchSpanProcessorConfig: {
    maxExportBatchSize: 8,
    scheduledDelayMillis: 1_000,
  },
})

const sessionElement = getElement('session-id')
const replayElement = getElement('replay-state')
const routeElement = getElement('route-state')
const statusElement = getElement('status')
const logElement = getElement('event-log')
const resultsElement = getElement('results')
const dynamicRegionElement = getElement('dynamic-region')
const userIdInput = getInput('user-id')
const regionSelect = getSelect('region')

sessionElement.textContent = logfire.getBrowserSessionId() ?? 'unavailable'
replayElement.textContent = 'enabled, full sample'
routeElement.textContent = routeTemplate(window.location.pathname)
logEvent('configured browser SDK')

button('catalog').addEventListener('click', () => {
  void loadCatalog()
})

button('xhr').addEventListener('click', () => {
  void loadInventoryWithXhr()
})

button('checkout').addEventListener('click', () => {
  void runCheckout()
})

button('shift').addEventListener('click', () => {
  createLayoutShift()
})

button('console').addEventListener('click', () => {
  console.warn('Logfire replay console capture example', {
    route: routeTemplate(window.location.pathname),
    demo: true,
  })
  logfire.warning('Browser replay console event generated', {
    'example.action': 'console',
  })
  setStatus('console event emitted')
  logEvent('console.warn captured by replay')
})

button('error').addEventListener('click', () => {
  reportExampleError()
})

button('route').addEventListener('click', () => {
  const orderId = Date.now().toString(36)
  history.pushState({}, '', `/orders/${orderId}?token=route-secret#details`)
  routeElement.textContent = routeTemplate(window.location.pathname)
  logfire.info('Browser route changed', {
    'app.route': routeTemplate(window.location.pathname),
    'example.action': 'route',
  })
  setStatus('route changed')
  logEvent(`route changed to ${window.location.pathname}`)
})

window.addEventListener('popstate', () => {
  routeElement.textContent = routeTemplate(window.location.pathname)
})

async function loadCatalog(): Promise<void> {
  setStatus('loading catalog')
  logEvent('fetch catalog started')
  const region = regionSelect.value
  try {
    await logfire.span('browser replay catalog workflow', {
      attributes: {
        'app.route': routeTemplate(window.location.pathname),
        'example.action': 'catalog',
        'example.region': region,
      },
      callback: async () => {
        logfire.info('Catalog fetch requested', {
          'example.region': region,
        })
        const response = await fetch(
          `${proxyOrigin}/api/catalog?region=${encodeURIComponent(region)}&token=client-secret&email=demo@example.com`
        )
        if (!response.ok) {
          throw new Error(`catalog failed with ${String(response.status)}`)
        }
        const catalog = (await response.json()) as CatalogResponse
        renderCatalog(catalog)
        setStatus(`catalog loaded for ${catalog.region}`)
        logEvent(`fetch catalog completed with ${String(catalog.products.length)} products`)
      },
    })
  } catch (error) {
    failAction('catalog', error)
  }
}

async function loadInventoryWithXhr(): Promise<void> {
  setStatus('checking inventory')
  logEvent('xhr inventory started')
  try {
    const inventory = await logfire.span('browser replay xhr inventory', {
      attributes: {
        'example.action': 'xhr',
      },
      callback: async () => xhrJson<InventoryResponse>(`${proxyOrigin}/api/inventory?secret=inventory-secret`),
    })
    setStatus(`inventory ${String(inventory.available)} at ${inventory.warehouse}`)
    logEvent(`xhr inventory completed at ${inventory.checkedAt}`)
  } catch (error) {
    failAction('inventory', error)
  }
}

async function runCheckout(): Promise<void> {
  setStatus('checkout running')
  logEvent('checkout workflow started')
  try {
    await logfire.span('browser replay checkout workflow', {
      attributes: {
        'app.route': routeTemplate(window.location.pathname),
        'example.action': 'checkout',
        'enduser.id': getUserId(),
      },
      callback: async () => {
        await logfire.span('browser replay validate cart', {
          attributes: {
            'example.step': 'validate',
          },
          callback: async () => {
            await delay(90)
          },
        })
        await logfire.span('browser replay submit order', {
          attributes: {
            'example.step': 'submit',
          },
          callback: async () => {
            const response = await fetch(`${proxyOrigin}/api/checkout?secret=checkout-secret`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                userId: getUserId(),
                region: regionSelect.value,
                privateNote: getInput('private-note').value,
              }),
            })
            if (!response.ok) {
              throw new Error(`checkout failed with ${String(response.status)}`)
            }
            const checkout = (await response.json()) as CheckoutResponse
            appendResult(checkout.orderId, checkout.userId, checkout.accepted ? 'accepted' : 'rejected')
            logfire.info('Checkout accepted', {
              'example.order_id': checkout.orderId,
            })
          },
        })
      },
    })
    setStatus('checkout accepted')
    logEvent('checkout workflow completed')
  } catch (error) {
    failAction('checkout', error)
  }
}

function createLayoutShift(): void {
  const banner = document.createElement('section')
  banner.className = 'shift-banner'
  banner.textContent = `Layout shift at ${new Date().toLocaleTimeString()} for ${routeTemplate(window.location.pathname)}`
  dynamicRegionElement.prepend(banner)
  logfire.info('Browser replay layout shift generated', {
    'example.action': 'layout-shift',
  })
  setStatus('layout shift generated')
  logEvent('layout shift generated')
}

function reportExampleError(): void {
  try {
    throw new Error('Browser RUM replay example error')
  } catch (error) {
    logfire.reportError('Browser RUM replay example error', error, {
      'app.route': routeTemplate(window.location.pathname),
      'example.action': 'error',
    })
    console.error('Logfire replay error capture example', error)
    setStatus('error reported')
    logEvent('reported caught error')
  }
}

function renderCatalog(catalog: CatalogResponse): void {
  resultsElement.replaceChildren()
  for (const product of catalog.products) {
    appendResult(product.sku, product.name, `${String(product.stock)} in stock`)
  }
}

function appendResult(primary: string, secondary: string, badge: string): void {
  const row = document.createElement('div')
  row.className = 'result-row'
  const code = document.createElement('span')
  code.className = 'sku'
  code.textContent = primary
  const name = document.createElement('strong')
  name.textContent = secondary
  const pill = document.createElement('span')
  pill.className = 'pill'
  pill.textContent = badge
  row.append(code, name, pill)
  resultsElement.append(row)
}

function xhrJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('GET', url)
    xhr.responseType = 'json'
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response as T)
        return
      }
      reject(new Error(`XHR failed with ${String(xhr.status)}`))
    })
    xhr.addEventListener('error', () => {
      reject(new Error('XHR network error'))
    })
    xhr.send()
  })
}

function setStatus(status: string): void {
  statusElement.textContent = status
}

function failAction(action: 'catalog' | 'inventory' | 'checkout', error: unknown): void {
  setStatus(`${action} failed`)
  logEvent(`${action} failed`)
  logfire.reportError('Browser replay example action failed', error, {
    'example.action': action,
  })
}

function logEvent(message: string): void {
  const timestamp = new Date().toLocaleTimeString()
  logElement.textContent = `[${timestamp}] ${message}\n${logElement.textContent ?? ''}`.slice(0, 3_000)
}

function getUserId(): string {
  return userIdInput.value.trim() || 'anonymous'
}

function currentView(): string {
  const path = routeTemplate(window.location.pathname)
  return path === '/' ? 'workbench' : path.replace(/^\//u, '')
}

function routeTemplate(pathname: string): string {
  if (/^\/orders\/[^/]+$/u.test(pathname)) {
    return '/orders/:id'
  }
  if (pathname === '' || pathname === '/') {
    return '/'
  }
  return pathname
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

function getElement(id: string): HTMLElement {
  const element = document.getElementById(id)
  if (element === null) {
    throw new Error(`missing #${id}`)
  }
  return element
}

function getInput(id: string): HTMLInputElement {
  const element = getElement(id)
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`#${id} is not an input`)
  }
  return element
}

function getSelect(id: string): HTMLSelectElement {
  const element = getElement(id)
  if (!(element instanceof HTMLSelectElement)) {
    throw new Error(`#${id} is not a select`)
  }
  return element
}

function button(action: string): HTMLButtonElement {
  const element = document.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)
  if (element === null) {
    throw new Error(`missing [data-action="${action}"]`)
  }
  return element
}
