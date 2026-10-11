import { gunzipSync } from 'node:zlib'

import { expect, test as base } from '@playwright/test'

import type { ChunkEnvelope } from '../src/types'
import type { ReplayReceipt } from '../test-fixtures/delivery/vite.config'

const test = base.extend({
  channel: async ({ browserName }, use) => {
    await use(browserName === 'chromium' ? 'chromium' : undefined)
  },
})

// Playwright disables Chromium's BFCache by default. This flow must restore
// the original document, not merely reload the same URL from history.
test.use({ launchOptions: { ignoreDefaultArgs: ['--disable-back-forward-cache'] } })

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
