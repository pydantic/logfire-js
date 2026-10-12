import { resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

import { expect, test } from '@playwright/test'

import { repositoryRoot, runVerifier } from './runVerifier'

const deliveryVerifier = resolve(repositoryRoot, 'packages/logfire-session-replay/test-fixtures/delivery/verify.mjs')
const privacyVerifier = resolve(repositoryRoot, 'packages/logfire-browser/test-fixtures/privacy-defaults/verify.mjs')

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

    const response = await request.get('http://127.0.0.1:4177/fixture/status?scenario=unload')
    expect(response.ok()).toBe(true)
    const events = replayEvents(await response.text())
    const checkpoints = events.flatMap((event, index) => {
      const nextEvent = events[index + 1]
      return isRecord(event) && event['type'] === 4 && isRecord(nextEvent) && nextEvent['type'] === 2 ? [index] : []
    })
    expect(checkpoints).toHaveLength(2)
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
