import { gunzipSync } from 'node:zlib'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import type { RrwebEvent } from '../src/types'

type ReplayEvents = RrwebEvent[]
interface Chunk {
  id: string
  seq: number
  events: ReplayEvents
}
interface ExportedSpan {
  name: string
  startTimeUnixNano: string
  attributes: { key: string; value: { stringValue?: string; intValue?: string } }[]
}
declare global {
  interface Window {
    frustrationReplay: {
      handledClicks: number
      session(): string | undefined
      recording(): string | undefined
      flush(): Promise<void>
      stop(): Promise<void>
    }
  }
}

function attributes(span: ExportedSpan): Record<string, string | undefined> {
  return Object.fromEntries(span.attributes.map(({ key, value }) => [key, value.stringValue ?? value.intValue]))
}

async function start(page: Page) {
  const chunks: Chunk[] = []
  const spans: ExportedSpan[] = []
  await page.clock.install()
  // Every telemetry request is intercepted; no credentials or live project are used.
  await page.route('**/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'POST') {
      if (url.pathname.startsWith('/v1/replay/')) {
        const body = request.postDataBuffer()
        expect(body).not.toBeNull()
        const envelope = JSON.parse(gunzipSync(body ?? Buffer.alloc(0)).toString('utf8')) as { events: ReplayEvents; meta: { seq: number } }
        chunks.push({ id: url.pathname.split('/').at(-1) ?? '', seq: envelope.meta.seq, events: envelope.events })
        expect(envelope.meta.seq).toBe(Number(url.searchParams.get('seq')))
      } else {
        expect(url.pathname).toBe('/v1/traces')
        const body = request.postDataJSON() as { resourceSpans: { scopeSpans: { spans: ExportedSpan[] }[] }[] }
        spans.push(...body.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)))
      }
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })
  await page.goto('http://127.0.0.1:5189/replay.html')
  await expect(page.getByRole('status')).toHaveText('ready')
  await expect.poll(async () => page.evaluate(() => window.frustrationReplay.recording())).toBeTruthy()
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100))
  return { chunks, spans }
}

function eventsFor(chunks: Chunk[], id: string): ReplayEvents {
  const recording = chunks.filter((chunk) => chunk.id === id).sort((a, b) => a.seq - b.seq)
  expect(recording.length).toBeGreaterThan(0)
  expect(recording[0]?.seq).toBe(0)
  expect(new Set(recording.map((chunk) => chunk.seq)).size).toBe(recording.length)
  const events = recording.flatMap((chunk) => chunk.events)
  expect(events.some((event) => event.type === 2)).toBe(true)
  expect(JSON.stringify(events)).not.toContain('input-secret-canary')
  expect(JSON.stringify(events)).not.toContain('Checkout secret canary')
  return events
}

function expectRecordedClick(span: ExportedSpan, chunks: Chunk[]): ReplayEvents {
  const id = attributes(span)['logfire.session_replay.id']
  expect(id).toBeTruthy()
  const events = eventsFor(chunks, id ?? '')
  const clickTime = Number(BigInt(span.startTimeUnixNano) / 1000000n)
  // The signal is backdated to the original click, not the later detector deadline.
  expect(events.some((event) => event.timestamp <= clickTime)).toBe(true)
  expect(events.some((event) => event.timestamp >= clickTime)).toBe(true)
  expect(
    events.some(
      (event) =>
        event.type === 3 &&
        typeof event.data === 'object' &&
        event.data !== null &&
        'source' in event.data &&
        event.data.source === 2 &&
        'type' in event.data &&
        event.data.type === 2 &&
        Math.abs(event.timestamp - clickTime) <= 5
    )
  ).toBe(true)
  return events
}

test.describe('frustration with the real replay recorder', () => {
  test('exports one correlated rage signal with automatic instrumentation and playable masked DOM', async ({ page, context }) => {
    const { chunks, spans } = await start(page)
    await page.getByRole('button', { name: 'Checkout secret canary', exact: true }).click({ clickCount: 3, delay: 100 })
    expect(await page.evaluate(() => window.frustrationReplay.handledClicks)).toBe(3)
    await page.clock.runFor(200)
    await page.evaluate(async () => window.frustrationReplay.stop())
    const signals = spans.filter((span) => span.name === 'browser.rage_click')
    expect(signals).toHaveLength(1)
    expect(spans.filter((span) => attributes(span)['event_type'] === 'click')).toHaveLength(3)
    const signal = signals[0]
    if (signal === undefined) {
      throw new Error('missing rage signal')
    }
    const events = expectRecordedClick(signal, chunks)
    expect(JSON.stringify(signal)).not.toContain('secret-canary')
    const playback = await context.newPage()
    try {
      await playback.goto('http://127.0.0.1:4177/playback.html')
      // Playwright's installed clock is context-wide, including this playback page.
      await playback.clock.resume()
      await playback.evaluate(async (recorded) => window.logfireReplayPlayback.load(recorded), events)
      await expect(playback.frameLocator('iframe').getByRole('button')).toHaveCount(2)
      await expect(playback.frameLocator('iframe').getByRole('button').first()).not.toHaveText('Checkout secret canary')
    } finally {
      await playback.close()
    }
  })

  test('keeps delayed signals on their click-time recording across idle rotation and reload', async ({ page }) => {
    const { chunks, spans } = await start(page)
    const original = await page.evaluate(() => ({
      session: window.frustrationReplay.session(),
      recording: window.frustrationReplay.recording(),
    }))
    await page.getByRole('button', { name: 'No response secret canary' }).click()
    await page.clock.runFor(7400)
    await page.evaluate(async () => window.frustrationReplay.flush())
    const first = spans.filter((span) => span.name === 'browser.dead_click')
    expect(first).toHaveLength(1)
    expect(attributes(first[0] as ExportedSpan)).toMatchObject({
      'session.id': original.session,
      'logfire.session_replay.id': original.recording,
    })
    expectRecordedClick(first[0] as ExportedSpan, chunks)
    await page.clock.runFor(11000)
    // Reading the public session identity triggers the usual idle rollover, not a test-only mutation.
    expect(await page.evaluate(() => window.frustrationReplay.session())).not.toBe(original.session)
    await page.clock.runFor(1100)
    await expect.poll(async () => page.evaluate(() => window.frustrationReplay.recording())).toBeTruthy()
    expect(await page.evaluate(() => window.frustrationReplay.recording())).not.toBe(original.recording)
    await page.getByRole('button', { name: 'Checkout secret canary' }).click({ clickCount: 3, delay: 100 })
    await page.evaluate(async () => window.frustrationReplay.flush())
    await page.clock.runFor(200)
    const rotated = await page.evaluate(() => ({
      session: window.frustrationReplay.session(),
      recording: window.frustrationReplay.recording(),
    }))
    // Reload uses the SDK's normal unload flushing and persisted recording identity.
    await page.reload()
    await expect(page.getByRole('status')).toHaveText('ready')
    await expect.poll(async () => page.evaluate(() => window.frustrationReplay.recording())).toBe(rotated.recording)
    expect(await page.evaluate(() => window.frustrationReplay.session())).toBe(rotated.session)
    await page.getByRole('button', { name: 'Checkout secret canary' }).click({ clickCount: 3, delay: 100 })
    await page.evaluate(async () => window.frustrationReplay.stop())
    const rage = spans.filter((span) => span.name === 'browser.rage_click')
    expect(rage).toHaveLength(2)
    for (const signal of rage) {
      expect(attributes(signal)).toMatchObject({ 'session.id': rotated.session, 'logfire.session_replay.id': rotated.recording })
      expectRecordedClick(signal, chunks)
    }
  })
})
