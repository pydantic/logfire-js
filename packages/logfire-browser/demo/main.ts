import { SimpleSpanProcessor, WebTracerProvider } from '@opentelemetry/sdk-trace-web'
import { BrowserSessionSpanProcessor } from '../src/BrowserSessionSpanProcessor'
import { BrowserSessionManager } from '../src/browserSession'
import { BrowserSessionReplayState } from '../src/sessionReplay'
import { startBrowserFrustration } from '../src/browserFrustration'

// Shadow DOM keeps the diagnostic feed's own mutations out of the observed application.
function element(selector: string, root: Document | ShadowRoot = document): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector)
  if (found === null) {
    throw new Error(`Playground element missing: ${selector}`)
  }
  return found
}
const feed = element('#feed').attachShadow({ mode: 'open' })
feed.innerHTML =
  '<style>:host{display:block}.events{border:1px solid #30323e;border-radius:12px;min-height:140px}.empty{padding:44px 20px;text-align:center;color:#858ba3;font-size:13px}.event{display:flex;gap:18px;align-items:center;padding:18px 22px;border-bottom:1px solid #30323e}.event:last-child{border:0}.dot{width:8px;height:8px;border-radius:50%;background:#ec9567;flex-shrink:0}strong{font-size:13px}small{display:block;color:#959bb1;margin-top:5px;font-size:12px}time{margin-left:auto;color:#9da3b8;font-size:12px;white-space:nowrap}</style><div class="events"><div class="empty">No signals yet. Start with three quick clicks on “Try again”.</div></div>'
const events = element('.events', feed)
const sessionManager = new BrowserSessionManager({ storage: null, getRouteName: () => '/playground' })
const labels: Record<string, string> = {
  rage_click: 'Rapid repeated clicks',
  slow_click: 'Slow response observed',
  dead_click: 'No response observed',
}
const provider = new WebTracerProvider({
  spanProcessors: [
    new BrowserSessionSpanProcessor(sessionManager),
    new SimpleSpanProcessor({
      export(spans, done) {
        for (const span of spans) {
          feed.querySelector('.empty')?.remove()
          const row = document.createElement('div')
          row.className = 'event'
          const kind = String(span.attributes['logfire.interaction.kind'])
          const delay = Number(span.attributes['logfire.interaction.delay_ms'])
          const title = document.createElement('strong')
          title.textContent = labels[kind] ?? kind
          const detail = document.createElement('small')
          detail.textContent = `${String(span.attributes['logfire.interaction.click_count'])} clicks · /playground · button · detector v1`
          const copy = document.createElement('div')
          copy.append(title, detail)
          const dot = document.createElement('span')
          dot.className = 'dot'
          const time = document.createElement('time')
          time.textContent = `${(delay / 1000).toFixed(1)}s`
          row.append(dot, copy, time)
          events.prepend(row)
        }
        done({ code: 0 })
      },
      shutdown: async () => Promise.resolve(),
    }),
  ],
})
startBrowserFrustration({
  sessionManager,
  replayState: new BrowserSessionReplayState(),
  tracer: provider.getTracer('playground'),
  deadClicks: true,
})
element('#healthy').addEventListener('click', () => {
  element('#healthy-status').textContent = '✓ Draft saved'
})
element('#slow').addEventListener('click', () => {
  setTimeout(() => {
    element('#slow-status').textContent = '✓ Report ready'
  }, 3400)
})
