import { resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

import { expect, test } from '@playwright/test'

import { repositoryRoot, runVerifier } from './runVerifier'

const deliveryVerifier = resolve(repositoryRoot, 'packages/logfire-session-replay/test-fixtures/delivery/verify.mjs')
const privacyVerifier = resolve(repositoryRoot, 'packages/logfire-browser/test-fixtures/privacy-defaults/verify.mjs')

test.describe('recording identity', () => {
  test('a child reload continues after its opener navigates cross-origin', async ({ page, request }) => {
    await request.post('http://127.0.0.1:4177/fixture/reset?scenario=identity')
    await page.goto('http://127.0.0.1:4177/identity.html')
    await expect(page.getByRole('status')).toHaveText('ready')
    const childPromise = page.waitForEvent('popup')
    await page.getByRole('button', { name: 'Open another tab' }).click()
    const child = await childPromise
    try {
      await expect(child.getByRole('status')).toHaveText('ready')
      const childId = await child.evaluate(() => window.logfireReplayIdentity.recordingId)
      await page.route('https://opener.example.invalid/', async (route) => {
        await route.fulfill({ body: '<p>Uninstrumented cross-origin page</p>', contentType: 'text/html' })
      })
      await page.goto('https://opener.example.invalid/')
      await child.reload()
      await expect(child.getByRole('status')).toHaveText('ready')
      expect(await child.evaluate(() => window.logfireReplayIdentity.recordingId)).toBe(childId)
    } finally {
      await child.evaluate(async () => window.logfireReplayIdentity.stop())
      await child.close()
    }
  })

  test('a new tab from an uninstrumented page does not resume its released replay', async ({ page, request }) => {
    await request.post('http://127.0.0.1:4177/fixture/reset?scenario=identity')
    await page.goto('http://127.0.0.1:4177/identity.html')
    await expect(page.getByRole('status')).toHaveText('ready')
    const firstId = await page.evaluate(() => window.logfireReplayIdentity.recordingId)
    await page.goto('http://127.0.0.1:4177/after-unload.html')
    const childPromise = page.waitForEvent('popup')
    await page.evaluate(() => {
      window.open('/identity.html', '_blank')
    })
    const child = await childPromise
    try {
      await expect(child.getByRole('status')).toHaveText('ready')
      const childId = await child.evaluate(() => window.logfireReplayIdentity.recordingId)
      expect(childId).not.toBe(firstId)
      await child.reload()
      await expect(child.getByRole('status')).toHaveText('ready')
      expect(await child.evaluate(() => window.logfireReplayIdentity.recordingId)).toBe(childId)
      await page.goto('http://127.0.0.1:4177/identity.html')
      await expect(page.getByRole('status')).toHaveText('ready')
      expect(await page.evaluate(() => window.logfireReplayIdentity.recordingId)).toBe(firstId)
    } finally {
      await child.evaluate(async () => window.logfireReplayIdentity.stop())
      await child.close()
      await page.evaluate(async () => {
        if (window.location.pathname === '/identity.html') {
          await window.logfireReplayIdentity.stop()
        }
      })
    }
  })

  test('an opener tab and its cloned storage produce independently playable recordings', async ({ page, context, request }) => {
    await request.post('http://127.0.0.1:4177/fixture/reset?scenario=identity')
    await page.goto('http://127.0.0.1:4177/identity.html')
    await expect(page.getByRole('status')).toHaveText('ready')
    const first = await page.evaluate(() => ({
      recordingId: window.logfireReplayIdentity.recordingId,
      rumSessionId: window.logfireReplayIdentity.rumSessionId,
    }))
    const childPromise = page.waitForEvent('popup')
    await page.getByRole('button', { name: 'Open another tab' }).click()
    const child = await childPromise
    try {
      await expect(child.getByRole('status')).toHaveText('ready')
      const second = await child.evaluate(() => ({
        inheritedSequence: window.logfireReplayIdentity.inheritedSequence,
        recordingId: window.logfireReplayIdentity.recordingId,
        rumSessionId: window.logfireReplayIdentity.rumSessionId,
      }))
      expect(first.recordingId).not.toBe(second.recordingId)
      expect(first.rumSessionId).toBe(second.rumSessionId)
      expect(JSON.parse(second.inheritedSequence ?? '{}')).toEqual({ id: first.recordingId, seq: 1 })
      await page.evaluate(async () => window.logfireReplayIdentity.stop())
      await child.evaluate(async () => window.logfireReplayIdentity.stop())

      const response = await request.get('http://127.0.0.1:4177/fixture/status?scenario=identity')
      expect(response.ok()).toBe(true)
      const evidence = parseRecord(await response.text(), 'identity evidence')
      const receipts = evidence['receipts']
      expect(Array.isArray(receipts)).toBe(true)
      if (!Array.isArray(receipts)) {
        throw new Error('identity evidence has no receipts')
      }
      const playback = await context.newPage()
      try {
        for (const [recordingId, marker] of [
          [first.recordingId, 'parent-marker'],
          [second.recordingId, 'child-marker'],
        ] as const) {
          const recordingReceipts = receipts.filter(
            (receipt: unknown) =>
              isRecord(receipt) &&
              typeof receipt['url'] === 'string' &&
              new URL(receipt['url'], 'http://127.0.0.1:4177').pathname === `/replay/identity/${recordingId}`
          )
          expect(recordingReceipts.length).toBeGreaterThan(0)
          expect(recordingReceipts[0]).toMatchObject({ seq: 0, accepted: true })
          const events = replayEvents(JSON.stringify({ receipts: recordingReceipts }))
          // eslint-disable-next-line no-await-in-loop -- exercise each independent rrweb DOM mirror separately.
          await playback.goto('http://127.0.0.1:4177/playback.html')
          // eslint-disable-next-line no-await-in-loop -- wait until that recording is loaded.
          await playback.evaluate(async (recordedEvents) => window.logfireReplayPlayback.load(recordedEvents), events)
          // eslint-disable-next-line no-await-in-loop -- verify the corresponding recording, not a combined event stream.
          await expect(playback.frameLocator('iframe').getByText(marker, { exact: true })).toBeVisible()
        }
      } finally {
        await playback.close()
      }
    } finally {
      await page.evaluate(async () => window.logfireReplayIdentity.stop())
      await child.evaluate(async () => window.logfireReplayIdentity.stop())
      await child.close()
    }
  })

  test('a reload continues the replay and its sequence while retaining RUM identity', async ({ page, request }) => {
    await request.post('http://127.0.0.1:4177/fixture/reset?scenario=identity')
    await page.goto('http://127.0.0.1:4177/identity.html')
    await expect(page.getByRole('status')).toHaveText('ready')
    const first = await page.evaluate(() => ({
      recordingId: window.logfireReplayIdentity.recordingId,
      rumSessionId: window.logfireReplayIdentity.rumSessionId,
    }))
    await page.reload()
    await expect(page.getByRole('status')).toHaveText('ready')
    try {
      const second = await page.evaluate(() => ({
        recordingId: window.logfireReplayIdentity.recordingId,
        rumSessionId: window.logfireReplayIdentity.rumSessionId,
      }))
      expect(second.recordingId).toBe(first.recordingId)
      expect(second.rumSessionId).toBe(first.rumSessionId)
      const response = await request.get('http://127.0.0.1:4177/fixture/status?scenario=identity')
      expect(response.ok()).toBe(true)
      const evidence = parseRecord(await response.text(), 'reload evidence')
      const receipts = evidence['receipts']
      if (!Array.isArray(receipts)) {
        throw new Error('reload evidence has no receipts')
      }
      const sequences = receipts.map((receipt: unknown) => (isRecord(receipt) ? receipt['seq'] : undefined))
      expect(sequences.length).toBeGreaterThanOrEqual(2)
      expect(new Set(sequences).size).toBe(sequences.length)
      expect(
        receipts.every(
          (receipt: unknown) =>
            isRecord(receipt) &&
            typeof receipt['url'] === 'string' &&
            new URL(receipt['url'], 'http://127.0.0.1:4177').pathname === `/replay/identity/${first.recordingId}`
        )
      ).toBe(true)
    } finally {
      await page.evaluate(async () => window.logfireReplayIdentity.stop())
    }
  })

  test('same-tab navigation and back retain the replay without reusing sequences', async ({ page, request }) => {
    await request.post('http://127.0.0.1:4177/fixture/reset?scenario=identity')
    await page.goto('http://127.0.0.1:4177/identity.html')
    await expect(page.getByRole('status')).toHaveText('ready')
    const recordingId = await page.evaluate(() => window.logfireReplayIdentity.recordingId)
    await page.getByRole('link', { name: 'Navigate in this tab' }).click()
    await expect(page).toHaveURL('http://127.0.0.1:4177/identity.html?next=true')
    await expect(page.getByRole('status')).toHaveText('ready')
    expect(await page.evaluate(() => window.logfireReplayIdentity.recordingId)).toBe(recordingId)
    await page.goBack()
    await expect(page.getByRole('status')).toHaveText('ready')
    try {
      expect(await page.evaluate(() => window.logfireReplayIdentity.recordingId)).toBe(recordingId)
      await page.evaluate(async () => window.logfireReplayIdentity.stop())
      const response = await request.get('http://127.0.0.1:4177/fixture/status?scenario=identity')
      expect(response.ok()).toBe(true)
      const receipts = parseRecord(await response.text(), 'navigation evidence')['receipts']
      if (!Array.isArray(receipts)) {
        throw new Error('navigation evidence has no receipts')
      }
      const sequences = receipts.map((receipt: unknown) => (isRecord(receipt) ? receipt['seq'] : undefined))
      expect(sequences.length).toBeGreaterThanOrEqual(3)
      expect(new Set(sequences).size).toBe(sequences.length)
    } finally {
      await page.evaluate(async () => window.logfireReplayIdentity.stop())
    }
  })
})

declare global {
  interface Window {
    logfireReplayPlayback: {
      load(events: unknown[]): Promise<void>
    }
  }
}

test.describe('session replay delivery in Chromium', () => {
  for (const scenario of ['csp', 'retry-after', 'utf8'] as const) {
    test(scenario, async ({ page }, testInfo) => {
      await page.goto(`http://127.0.0.1:4177/${scenario}/`)
      await expect(page.locator('#status')).toHaveText(/^(?:complete|failed)$/u)
      await expect(page.locator('#status')).toHaveText('complete')
      await runVerifier(deliveryVerifier, scenario, testInfo)
    })
  }

  test('unload chunks remain ordered and playable', async ({ page, request }, testInfo) => {
    await page.goto('http://127.0.0.1:4177/unload/')
    await expect(page.locator('#status')).toHaveText('ready')
    await page.locator('#leave').click()
    await expect(page).toHaveURL('http://127.0.0.1:4177/after-unload.html')
    await expect(page.locator('#status')).toHaveText('navigation complete')

    await runVerifier(deliveryVerifier, 'unload', testInfo)
    const response = await request.get('http://127.0.0.1:4177/fixture/status?scenario=unload')
    expect(response.ok()).toBe(true)
    const events = replayEvents(await response.text())

    await page.goto('http://127.0.0.1:4177/playback.html')
    await page.evaluate(async (recordedEvents) => window.logfireReplayPlayback.load(recordedEvents), events)
    const replayedText = await page.frameLocator('iframe').locator('#payload').textContent()
    expect(replayedText?.slice(0, 18)).toBe('unload-marker-two:')
    expect(replayedText?.length).toBe(26_018)
  })

  test('a lost chunk re-anchors so later changes replay', async ({ page, request }, testInfo) => {
    await page.goto('http://127.0.0.1:4177/gap/')
    await expect(page.locator('#status')).toHaveText(/^(?:complete|failed)$/u)
    await expect(page.locator('#status')).toHaveText('complete')
    await runVerifier(deliveryVerifier, 'gap', testInfo)

    const response = await request.get('http://127.0.0.1:4177/fixture/status?scenario=gap')
    expect(response.ok()).toBe(true)
    const events = replayEvents(await response.text())
    await page.goto('http://127.0.0.1:4177/playback.html')
    await page.evaluate(async (recordedEvents) => window.logfireReplayPlayback.load(recordedEvents), events)
    await expect(page.frameLocator('iframe').locator('#late')).toHaveText('gap-after')
  })

  test('navigation drops a replay shorter than five seconds', async ({ page, request }) => {
    await page.goto('http://127.0.0.1:4177/short/')
    await expect(page.locator('#status')).toHaveText('ready')
    await page.locator('#leave').click()
    await expect(page).toHaveURL('http://127.0.0.1:4177/after-unload.html')
    await page.waitForTimeout(500)

    const response = await request.get('http://127.0.0.1:4177/fixture/status?scenario=short')
    expect(response.ok()).toBe(true)
    const evidence = parseRecord(await response.text(), 'short-session evidence')
    expect(evidence['receipts']).toEqual([])
  })
})

test.describe('session replay privacy', () => {
  for (const scenario of ['default', 'opt-in'] as const) {
    test(scenario, async ({ page }, testInfo) => {
      const secret = `${scenario}-page-secret`
      await page.goto(`http://127.0.0.1:4178/${scenario}/?page_secret=${secret}#${scenario}-fragment-secret`)
      await expect(page.locator('#status')).toHaveText(/^(?:complete|failed)$/u)
      await expect(page.locator('#status')).toHaveText('complete')
      await runVerifier(privacyVerifier, scenario, testInfo)
    })
  }
})

function replayEvents(serializedEvidence: string): unknown[] {
  const evidence = parseRecord(serializedEvidence, 'delivery evidence')
  const receipts = evidence['receipts']
  if (!Array.isArray(receipts)) {
    throw new Error('delivery evidence has no receipts')
  }
  return (
    receipts
      .map((value) => {
        if (!isRecord(value) || typeof value['body'] !== 'string' || typeof value['seq'] !== 'number') {
          throw new Error('delivery evidence contains an invalid receipt')
        }
        return { accepted: value['accepted'] !== false, body: value['body'], seq: value['seq'] }
      })
      // The server did not store rejected chunks, so playback must not see them.
      .filter(({ accepted }) => accepted)
      .sort((left, right) => left.seq - right.seq)
      .flatMap(({ body }) => {
        const envelope = parseRecord(gunzipSync(Buffer.from(body, 'base64')).toString('utf8'), 'replay envelope')
        const events = envelope['events']
        if (!Array.isArray(events)) {
          throw new Error('replay envelope has no events')
        }
        const values: unknown[] = []
        for (const event of events) {
          values.push(event)
        }
        return values
      })
  )
}

function parseRecord(serialized: string, name: string): Record<string, unknown> {
  const value: unknown = JSON.parse(serialized)
  if (!isRecord(value)) {
    throw new Error(`${name} is not an object`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
