import { resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

import { expect, test } from '@playwright/test'
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test'

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

  test('a copy of a live tab starts its own recording instead of writing the live one', async ({ page, context, request }) => {
    await request.post('http://127.0.0.1:4177/fixture/reset?scenario=identity')
    await page.goto('http://127.0.0.1:4177/identity.html')
    await expect(page.getByRole('status')).toHaveText('ready')
    const liveRecordingId = await page.evaluate(() => window.logfireReplayIdentity.recordingId)
    const copy = await openWithCopiedStorage(context, await releasedStorageCopy(page))
    try {
      await expect(copy.getByRole('status')).toHaveText('ready')
      const copyRecordingId = await copy.evaluate(() => window.logfireReplayIdentity.recordingId)
      expect(copyRecordingId).not.toBe(liveRecordingId)
      await mutateAndFlush(page, 'live-after-copy')
      await mutateAndFlush(copy, 'copy-after-copy')
      expect(await page.evaluate(() => window.logfireReplayIdentity.recordingId)).toBe(liveRecordingId)
      const receipts = await identityReceipts(request)
      expectOneBodyPerSequence(receipts)
      expect(receipts.filter((receipt) => receipt.recordingId === copyRecordingId).map((receipt) => receipt.seq)[0]).toBe(0)
    } finally {
      await copy.evaluate(async () => window.logfireReplayIdentity.stop())
      await copy.close()
      await page.evaluate(async () => window.logfireReplayIdentity.stop())
    }
  })

  test('a stale copy continues a released recording after the last sequence its writer reserved', async ({ page, context, request }) => {
    await request.post('http://127.0.0.1:4177/fixture/reset?scenario=identity')
    await page.goto('http://127.0.0.1:4177/identity.html')
    await expect(page.getByRole('status')).toHaveText('ready')
    const recordingId = await page.evaluate(() => window.logfireReplayIdentity.recordingId)
    const staleCopy = await releasedStorageCopy(page)
    await mutateAndFlush(page, 'writer-after-copy-one')
    await mutateAndFlush(page, 'writer-after-copy-two')
    await page.goto('http://127.0.0.1:4177/after-unload.html')
    const copy = await openWithCopiedStorage(context, staleCopy)
    try {
      await expect(copy.getByRole('status')).toHaveText('ready')
      expect(await copy.evaluate(() => window.logfireReplayIdentity.recordingId)).toBe(recordingId)
      await mutateAndFlush(copy, 'copy-continues')
      const receipts = (await identityReceipts(request)).filter((receipt) => receipt.recordingId === recordingId)
      expectOneBodyPerSequence(receipts)
      const sequences = receipts.map((receipt) => receipt.seq)
      expect(new Set(sequences).size).toBe(sequences.length)
      expect(sequences).toEqual([...sequences].sort((left, right) => left - right))
    } finally {
      await copy.evaluate(async () => window.logfireReplayIdentity.stop())
      await copy.close()
    }
  })

  test('ten consecutive reloads keep one recording', async ({ page, request }) => {
    await request.post('http://127.0.0.1:4177/fixture/reset?scenario=identity')
    await page.goto('http://127.0.0.1:4177/identity.html')
    await expect(page.getByRole('status')).toHaveText('ready')
    const recordingId = await page.evaluate(() => window.logfireReplayIdentity.recordingId)
    try {
      for (let reload = 0; reload < 10; reload += 1) {
        // eslint-disable-next-line no-await-in-loop -- each reload must follow the previous document.
        await page.reload()
        // eslint-disable-next-line no-await-in-loop -- each reload must follow the previous document.
        await expect(page.getByRole('status')).toHaveText('ready')
        // eslint-disable-next-line no-await-in-loop -- each reload must follow the previous document.
        expect(await page.evaluate(() => window.logfireReplayIdentity.recordingId)).toBe(recordingId)
      }
      const receipts = await identityReceipts(request)
      expectOneBodyPerSequence(receipts)
      expect(new Set(receipts.map((receipt) => receipt.recordingId))).toEqual(new Set([recordingId]))
    } finally {
      await page.evaluate(async () => window.logfireReplayIdentity.stop())
    }
  })
})

interface IdentityReceipt {
  body: string
  recordingId: string
  seq: number
}

/** The tab's sessionStorage as a duplicate tab would copy it while the source page navigates away. */
async function releasedStorageCopy(page: Page): Promise<[string, string][]> {
  const entries = await page.evaluate(() => Object.entries(sessionStorage))
  return entries.filter(([key]) => key !== 'lf_session_replay_recording_owner')
}

async function openWithCopiedStorage(context: BrowserContext, entries: [string, string][]): Promise<Page> {
  const copy = await context.newPage()
  await copy.addInitScript((copied) => {
    if (sessionStorage.length === 0) {
      for (const [key, value] of copied) {
        sessionStorage.setItem(key, value)
      }
    }
  }, entries)
  await copy.goto('http://127.0.0.1:4177/identity.html')
  return copy
}

async function mutateAndFlush(page: Page, text: string): Promise<void> {
  await page.evaluate(async (payload) => {
    const element = document.querySelector('#payload')
    if (element !== null) {
      element.textContent = payload
    }
    await window.logfireReplayIdentity.flush()
  }, text)
}

async function identityReceipts(request: APIRequestContext): Promise<IdentityReceipt[]> {
  const response = await request.get('http://127.0.0.1:4177/fixture/status?scenario=identity')
  expect(response.ok()).toBe(true)
  const receipts = parseRecord(await response.text(), 'identity evidence')['receipts']
  if (!Array.isArray(receipts)) {
    throw new Error('identity evidence has no receipts')
  }
  return receipts.map((receipt: unknown) => {
    if (
      !isRecord(receipt) ||
      typeof receipt['url'] !== 'string' ||
      typeof receipt['seq'] !== 'number' ||
      typeof receipt['body'] !== 'string'
    ) {
      throw new Error('identity evidence has a malformed receipt')
    }
    const pathname = new URL(receipt['url'], 'http://127.0.0.1:4177').pathname
    return { body: receipt['body'], recordingId: pathname.replace('/replay/identity/', ''), seq: receipt['seq'] }
  })
}

/** The platform rejects a second, different body for one recording sequence. */
function expectOneBodyPerSequence(receipts: IdentityReceipt[]): void {
  const bodies = new Map<string, Set<string>>()
  for (const receipt of receipts) {
    const key = `${receipt.recordingId}:${String(receipt.seq)}`
    bodies.set(key, (bodies.get(key) ?? new Set()).add(receipt.body))
  }
  expect([...bodies].filter(([, distinct]) => distinct.size > 1).map(([key]) => key)).toEqual([])
}

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
    expect(replayedText?.length).toBe(600_018)
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

  test('a permanently rejected replay stops instead of resyncing', async ({ page, request }) => {
    await page.clock.install()
    await page.goto('http://127.0.0.1:4177/rejected/')
    await expect(page.locator('#status')).toHaveText(/^(?:complete|failed)$/u)
    await expect(page.locator('#status')).toHaveText('complete')
    await page.locator('#payload').evaluate((node) => {
      node.textContent = 'after-stop'
    })
    // Two resync intervals: a recorder that kept resyncing would upload another snapshot.
    await page.clock.runFor(130_000)

    const response = await request.get('http://127.0.0.1:4177/fixture/status?scenario=rejected')
    expect(response.ok()).toBe(true)
    const evidence = parseRecord(await response.text(), 'rejected-replay evidence')
    const receipts = evidence['receipts']
    expect(Array.isArray(receipts) ? receipts.length : receipts).toBe(1)
    const state = parseRecord(JSON.stringify(evidence['state']), 'rejected-replay state')
    expect(state['recording']).toBe(false)
    expect(state['errors']).toEqual(['replay chunk seq=0 rejected: replay ingest failed: 401'])
  })

  test('a five-minute checkpoint plays without the preceding recording', async ({ page, request }) => {
    const startedAt = Date.now()
    await page.clock.install({ time: startedAt })
    await page.goto('http://127.0.0.1:4177/unload/')
    await expect(page.locator('#status')).toHaveText('ready')
    await page.clock.setSystemTime(startedAt + 299_000)
    await page.locator('#payload').evaluate(async (node) => {
      node.textContent = 'before-five-minutes'
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve()
        })
      })
    })
    await page.clock.setSystemTime(startedAt + 301_000)
    await page.locator('#payload').evaluate((node) => {
      node.textContent = 'five-minute-checkpoint'
    })
    await expect(page.locator('#payload')).toHaveText('five-minute-checkpoint')
    await page.locator('#leave').click()
    await expect(page).toHaveURL('http://127.0.0.1:4177/after-unload.html')

    // The unload chunk is a keepalive request that can reach the fixture after the navigation completes.
    let events: unknown[] = []
    let checkpoints: number[] = []
    await expect
      .poll(async () => {
        const response = await request.get('http://127.0.0.1:4177/fixture/status?scenario=unload')
        expect(response.ok()).toBe(true)
        events = replayEvents(await response.text())
        checkpoints = events.flatMap((event, index) => {
          const nextEvent = events[index + 1]
          return isRecord(event) && event['type'] === 4 && isRecord(nextEvent) && nextEvent['type'] === 2 ? [index] : []
        })
        return checkpoints.length
      })
      .toBe(2)
    const checkpoint = checkpoints[1]
    if (checkpoint === undefined) {
      throw new Error('five-minute checkpoint was not recorded')
    }
    const header = events[checkpoint]
    expect(isRecord(header) && Number(header['timestamp']) - startedAt).toBeGreaterThanOrEqual(300_000)

    await page.goto('http://127.0.0.1:4177/playback.html')
    await page.evaluate(async (recordedEvents) => window.logfireReplayPlayback.load(recordedEvents), events.slice(checkpoint))
    await expect(page.frameLocator('iframe').locator('#payload')).toHaveText('five-minute-checkpoint')
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
