import { gunzipSync } from 'node:zlib'

import { expect, test as base } from '@playwright/test'

import type { ChunkEnvelope } from '../src/types'
import type { ReplayReceipt } from '../test-fixtures/delivery/vite.config'
import type { DemoEvidence } from '../../logfire-browser/demo/shop.types'
import type { FrustrationSafety } from './frustration-safety.types'

const test = base.extend({
  channel: async ({ browserName }, use) => {
    await use(browserName === 'chromium' ? 'chromium' : undefined)
  },
})

// Playwright disables Chromium's BFCache by default. This flow must restore
// the original document, not merely reload the same URL from history.
test.use({ launchOptions: { ignoreDefaultArgs: ['--disable-back-forward-cache'] } })

for (const demo of [
  { path: '/', action: 'Try again' },
  { path: '/shop.html', action: 'Place demo order' },
]) {
  test(`native BFCache keeps the ${demo.path} demo active after Back`, async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Native restoration is verified with full Chromium.')
    await page.goto(`http://127.0.0.1:5190${demo.path}`)
    await expect(page.getByText('No signals yet.', { exact: false })).toBeVisible()
    if (demo.path === '/shop.html') {
      await expect(page.getByText('Replay recording · text and inputs masked', { exact: true })).toBeVisible()
    }
    await page.evaluate(() => {
      window.addEventListener('pageshow', (event) => {
        if (event.persisted) {
          document.documentElement.dataset['backNavigation'] = 'restored'
        }
      })
      const link = document.createElement('a')
      link.href = '/safety.html?from=demo'
      link.textContent = 'Visit another demo page'
      document.body.prepend(link)
    })
    await page.getByRole('link', { name: 'Visit another demo page', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('ready')
    await page.goBack({ waitUntil: 'commit' })
    await expect(page.locator('html')).toHaveAttribute('data-back-navigation', 'restored')
    await page.getByRole('button', { name: demo.action, exact: true }).click({ clickCount: 3, delay: 100 })
    await expect(page.getByText('Rapid repeated clicks', { exact: true })).toHaveCount(1)
    if (demo.path === '/shop.html') {
      await page.getByRole('button', { name: 'Stop SDK', exact: true }).click()
      await expect(page.getByText('SDK stopped · no further recording or detection', { exact: true })).toBeVisible()
    }
  })
}

test('native BFCache resets frustration candidates and resumes the correlated recorder', async ({ page, request, browserName }) => {
  test.skip(browserName !== 'chromium', 'Native restoration requires full Chromium; other engines run the interaction matrix.')
  test.setTimeout(45000)
  await request.post('http://127.0.0.1:5190/__demo/reset')
  await page.goto('http://127.0.0.1:5190/safety.html')
  await expect(page.getByRole('status')).toHaveText('ready')
  await expect.poll(async () => page.evaluate(() => window.frustrationSafety.recording())).not.toBeUndefined()
  const original: { documentId: FrustrationSafety['documentId']; recording: string | undefined; session: string | undefined } =
    await page.evaluate(() => ({
      documentId: window.frustrationSafety.documentId,
      recording: window.frustrationSafety.recording(),
      session: window.frustrationSafety.session(),
    }))
  expect(typeof original.recording).toBe('string')
  await page.evaluate(() => {
    document.querySelector('#broken')?.addEventListener(
      'click',
      () => {
        location.assign('/safety.html?next=true')
      },
      { once: true }
    )
  })
  // Navigate from this click, without a second gesture cancelling its pending candidate.
  await page.getByRole('button', { name: 'Unresponsive action' }).click()
  await page.waitForURL('**/safety.html?next=true')
  await expect(page.getByRole('status')).toHaveText('ready')
  expect(await page.evaluate(() => window.frustrationSafety.documentId)).not.toBe(original.documentId)
  await page.goBack({ waitUntil: 'commit' })
  await expect.poll(async () => page.evaluate(() => window.frustrationSafety.shows)).toEqual([false, true])
  expect(await page.evaluate(() => window.frustrationSafety.documentId)).toBe(original.documentId)
  await expect.poll(async () => page.evaluate(() => window.frustrationSafety.recording())).toBe(original.recording)
  expect(await page.evaluate(() => window.frustrationSafety.session())).toBe(original.session)
  await page.waitForTimeout(7400)
  expect(await page.evaluate(() => window.frustrationSafety.signals)).toEqual([])
  await page.getByRole('button', { name: 'Unresponsive action' }).click({ clickCount: 3, delay: 100 })
  await page.evaluate(async () => window.frustrationSafety.stop())
  const response = await request.get('http://127.0.0.1:5190/__demo/receipts')
  expect(response.ok()).toBe(true)
  const evidence = (await response.json()) as DemoEvidence
  const signals = evidence.spans.filter(({ name }) => name.startsWith('browser.'))
  expect(signals.map(({ name }) => name)).toEqual(['browser.rage_click'])
  expect(signals[0]?.attributes.find(({ key }) => key === 'logfire.session_replay.id')?.value.stringValue).toBe(original.recording)
  const chunks = evidence.chunks.filter(({ id }) => id === original.recording)
  expect(chunks.length).toBeGreaterThan(1)
  expect(chunks.map(({ seq }) => seq)).toEqual(Array.from({ length: chunks.length }, (_, seq) => seq))
  expect(chunks.filter(({ events }) => events.some(({ type }) => type === 2)).length).toBeGreaterThan(1)
  expect(JSON.stringify(chunks)).not.toContain('safety-input-canary')
})

test('Chromium BFCache restores a fresh recorder at the latest sequence', async ({ page, request, context, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'Native cache restoration is verified with full Chromium; WebKit identity flows run separately.')
  await request.post('http://127.0.0.1:4177/fixture/reset?scenario=identity')
  await page.goto('http://127.0.0.1:4177/identity.html')
  await expect(page.getByRole('status')).toHaveText('ready')
  const original = await page.evaluate(() => ({
    documentId: window.logfireReplayIdentity.documentId,
    recordingId: window.logfireReplayIdentity.recordingId,
  }))
  await page.getByRole('link', { name: 'Navigate in this tab' }).click()
  await expect(page.getByRole('status')).toHaveText('ready')
  expect(await page.evaluate(() => window.logfireReplayIdentity.documentId)).not.toBe(original.documentId)
  const before = await page.evaluate(() => sessionStorage.getItem('lf_session_replay_seq'))
  expect(await page.evaluate(() => window.logfireReplayIdentity.recordingId)).toBe(original.recordingId)
  await page.goBack({ waitUntil: 'commit' })
  await testInfo.attach('back-navigation', {
    body: await page.evaluate(() =>
      JSON.stringify({
        navigation: performance.getEntriesByType('navigation').map((entry) => ({ name: entry.name, type: entry.entryType })),
        restoreStates: window.logfireReplayIdentity.restoreStates,
      })
    ),
    contentType: 'application/json',
  })
  await expect.poll(async () => page.evaluate(() => window.logfireReplayIdentity.pageShows)).toEqual([false, true])
  try {
    expect(await page.evaluate(() => window.logfireReplayIdentity.documentId)).toBe(original.documentId)
    await page.evaluate(async () => window.logfireReplayIdentity.flush())
    expect(await page.evaluate(() => window.logfireReplayIdentity.recordingId)).toBe(original.recordingId)
    const after = await page.evaluate(() => sessionStorage.getItem('lf_session_replay_seq'))
    const beforeSequence = JSON.parse(before ?? '{}') as { id: string; seq: number }
    const afterSequence = JSON.parse(after ?? '{}') as { id: string; seq: number }
    expect(afterSequence.id).toBe(original.recordingId)
    expect(afterSequence.seq).toBeGreaterThan(beforeSequence.seq)
    await page.evaluate(async () => window.logfireReplayIdentity.stop())
    const response = await request.get('http://127.0.0.1:4177/fixture/status?scenario=identity')
    expect(response.ok()).toBe(true)
    const evidence = (await response.json()) as { receipts: ReplayReceipt[] }
    const receipts = evidence.receipts.filter(
      (receipt) => new URL(receipt.url, 'http://127.0.0.1:4177').pathname === `/replay/identity/${original.recordingId}`
    )
    expect(receipts.every((receipt) => receipt.accepted)).toBe(true)
    expect(new Set(receipts.map((receipt) => receipt.seq)).size).toBe(receipts.length)
    const restored = receipts.find((receipt) => receipt.seq === afterSequence.seq - 1)
    expect(restored).toBeDefined()
    if (restored === undefined) {
      throw new Error('No restored recording was uploaded')
    }
    const envelope = JSON.parse(gunzipSync(Buffer.from(restored.body, 'base64')).toString('utf8')) as ChunkEnvelope
    expect(envelope.events.map((event) => event.type)).toEqual(expect.arrayContaining([4, 2]))
    const playback = await context.newPage()
    try {
      await playback.goto('http://127.0.0.1:4177/playback.html')
      await playback.evaluate(async (events) => window.logfireReplayPlayback.load(events), envelope.events)
      await expect(playback.frameLocator('iframe').getByText('parent-marker', { exact: true })).toBeVisible()
    } finally {
      await playback.close()
    }
  } finally {
    await page.evaluate(async () => window.logfireReplayIdentity.stop())
  }
})
