import { configureFrontend } from '../dist/index.js'
import type { DemoEvidence } from './shop.types'

function element(id: string): HTMLElement {
  const found = document.getElementById(id)
  if (found === null) {
    throw new Error(`Missing demo element ${id}`)
  }
  return found
}

const monitor = element('signals').attachShadow({ mode: 'open' })
monitor.innerHTML = `<style>
  :host{display:block;margin-top:18px}p{font:12px/1.7 system-ui;color:#a7afc2;margin:10px 0}
  .event{display:flex;justify-content:space-between;align-items:center;gap:18px;padding:15px 0;border-bottom:1px solid #303746;font:13px system-ui}
  strong{font-weight:500;color:#e6a07d}small{display:block;color:#9aa5bc;margin-top:6px;font-size:11px}time{color:#afb8cc;white-space:nowrap;font-size:12px}
  </style><p id="connection">Recorder starting…</p><div id="events"><p id="empty">No signals yet. Try adding the mug, then one broken action.</p></div><p id="receipt" role="status">No upload verification yet.</p>`
function note(id: string, text: string): void {
  const found = monitor.getElementById(id)
  if (found !== null) {
    found.textContent = text
  }
}

function setting(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === '' ? undefined : trimmed
}
const cloudBase = setting(import.meta.env.VITE_LOGFIRE_BASE_URL)
const cloudToken = setting(import.meta.env.VITE_LOGFIRE_TOKEN)
if ((cloudBase === undefined) !== (cloudToken === undefined)) {
  throw new Error('Set both VITE_LOGFIRE_BASE_URL and VITE_LOGFIRE_TOKEN, or neither for local mode')
}
const cloud = cloudBase !== undefined && cloudToken !== undefined
element('destination').textContent = cloud ? 'Cloud ingest · demo data only' : 'Local HTTP ingest · not cloud'
element('watch').hidden = cloud
const labels: Record<string, string> = {
  rage_click: 'Rapid repeated clicks',
  dead_click: 'No response observed',
  slow_click: 'Slow response observed',
}
let signals = 0
const cleanup = configureFrontend({
  baseUrl: cloudBase ?? location.origin,
  token: cloudToken ?? 'local-demo-frontend-token',
  rum: {
    webVitals: false,
    frustration: { deadClicks: true },
    session: { getRouteName: () => '/demo/checkout' },
  },
  batchSpanProcessorConfig: { scheduledDelayMillis: 1000, maxExportBatchSize: 16 },
  sessionReplay: {
    load: async () => import('../../logfire-session-replay/dist/index.js'),
    sessionSampleRate: 1,
    flushIntervalMs: 5000,
    minSessionDurationMs: 0,
    captureConsole: false,
    blockSelector: '#replay-dialog',
    ignoreUrlPatterns: [/\/__demo\/receipts/u],
    onError: () => {
      note('connection', 'Replay encountered an error. Check the browser network panel; upload success is not verified.')
    },
  },
  spanProcessors: [
    {
      onStart: () => undefined,
      onEnd(span) {
        if (!span.name.startsWith('browser.') || span.attributes['logfire.interaction.kind'] === undefined) {
          return
        }
        signals++
        monitor.getElementById('empty')?.remove()
        const row = document.createElement('div')
        row.className = 'event'
        const copy = document.createElement('div')
        const title = document.createElement('strong')
        title.textContent = labels[String(span.attributes['logfire.interaction.kind'])] ?? span.name
        const detail = document.createElement('small')
        const count = Number(span.attributes['logfire.interaction.click_count'])
        detail.textContent = `${String(count)} ${count === 1 ? 'click' : 'clicks'} · /demo/checkout · detected locally, delivery not yet checked`
        copy.append(title, detail)
        const time = document.createElement('time')
        time.textContent = `${(Number(span.attributes['logfire.interaction.delay_ms']) / 1000).toFixed(1)}s`
        row.append(copy, time)
        monitor.getElementById('events')?.prepend(row)
        if (signals > 10) {
          monitor.getElementById('events')?.lastElementChild?.remove()
        }
      },
      forceFlush: async () => Promise.resolve(),
      shutdown: async () => Promise.resolve(),
    },
  ],
})

// Recorder startup is asynchronous. A one-shot flush waits for its public startup handle.
cleanup.sessionReplay?.flush().then(
  () => {
    note('connection', cleanup.sessionReplay?.recording === true ? 'Replay recording · text and inputs masked' : 'Replay is not recording')
  },
  () => {
    note('connection', 'Replay startup failed')
  }
)

element('add').addEventListener('click', () => {
  fetch('/__demo/cart')
    .then(async (response) => {
      if (!response.ok) {
        throw new Error('Cart request failed')
      }
      await response.json()
      element('cart-status').textContent = '✓ Added to your bag'
    })
    .catch(() => {
      element('cart-status').textContent = 'Could not add the item'
    })
})
element('shipping').addEventListener('click', () => {
  fetch('/__demo/shipping')
    .then(async (response) => {
      if (!response.ok) {
        throw new Error('Shipping request failed')
      }
      const result = (await response.json()) as { estimate: string }
      element('shipping-status').textContent = result.estimate
    })
    .catch(() => {
      element('shipping-status').textContent = 'Could not get the delivery estimate'
    })
})
// These represent wired-but-broken UI controls, not synthetic detector events.
element('discount-apply').addEventListener('click', () => undefined)
element('order').addEventListener('click', () => undefined)

async function receipts(): Promise<DemoEvidence> {
  await cleanup.sessionReplay?.flush()
  const response = await fetch('/__demo/receipts')
  if (!response.ok) {
    throw new Error('Could not read local receipts')
  }
  return response.json() as Promise<DemoEvidence>
}
element('uploads').addEventListener('click', () => {
  if (cloud) {
    note(
      'receipt',
      'Use the cloud project to verify browser.rage_click, browser.dead_click, and browser.slow_click. This demo cannot read cloud data.'
    )
    return
  }
  receipts().then(
    (evidence) => {
      const detected = evidence.spans.filter((span) =>
        ['browser.rage_click', 'browser.dead_click', 'browser.slow_click'].includes(span.name)
      )
      note(
        'receipt',
        `Local HTTP receipts: ${String(evidence.spans.length)} spans · ${String(detected.length)} interaction signals · ${String(evidence.chunks.length)} replay chunks. Cloud ingestion not tested.`
      )
    },
    () => {
      note('receipt', 'Could not verify local uploads. Check the browser network panel.')
    }
  )
})
const dialog = element('replay-dialog')
if (!(dialog instanceof HTMLDialogElement)) {
  throw new Error('Missing replay dialog')
}
let destroyPlayer: (() => void) | undefined
element('watch').addEventListener('click', () => {
  if (cloud) {
    return
  }
  receipts()
    .then(async (evidence) => {
      const id = evidence.chunks.at(-1)?.id
      const events = evidence.chunks
        .filter((chunk) => chunk.id === id)
        .sort((a, b) => a.seq - b.seq)
        .flatMap((chunk) => chunk.events)
      if (events.length < 2) {
        note('receipt', 'No playable local recording yet. Interact with the app first.')
        return
      }
      const { Replayer } = await import('@rrweb/replay')
      destroyPlayer?.()
      const root = element('playback')
      root.replaceChildren()
      const player = new Replayer(events, { root, mouseTail: false, showWarning: false })
      const resize = () => {
        const width = Number(player.iframe.width)
        const height = Number(player.iframe.height)
        if (width > 0 && height > 0) {
          const scale = Math.min(1, root.clientWidth / width)
          player.wrapper.style.transformOrigin = 'top left'
          player.wrapper.style.transform = `scale(${String(scale)})`
          root.style.height = `${String(height * scale)}px`
        }
      }
      const observer = new ResizeObserver(resize)
      observer.observe(root)
      player.on('resize', resize)
      destroyPlayer = () => {
        observer.disconnect()
        player.destroy()
      }
      dialog.showModal()
      resize()
      player.play()
    })
    .catch(() => {
      note('receipt', 'Could not play the local recording.')
    })
})
dialog.addEventListener('close', () => {
  destroyPlayer?.()
  destroyPlayer = undefined
})
element('close-replay').addEventListener('click', () => {
  dialog.close()
})
element('stop').addEventListener('click', () => {
  cleanup()
    .then(() => {
      note('connection', 'SDK stopped · no further recording or detection')
    })
    .catch(() => {
      note('connection', 'SDK shutdown encountered an error')
    })
})
