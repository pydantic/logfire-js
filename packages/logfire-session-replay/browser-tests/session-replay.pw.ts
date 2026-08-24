import { execFile as execFileCallback } from 'node:child_process'
import { resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

import { expect, test } from '@playwright/test'
import type { TestInfo } from '@playwright/test'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
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

async function runVerifier(path: string, scenario: string, testInfo: TestInfo): Promise<void> {
  const { stderr, stdout } = await new Promise<{ stderr: string; stdout: string }>((resolve, reject) => {
    execFileCallback(process.execPath, [path, scenario], { cwd: repositoryRoot, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(error.message, { cause: error }))
        return
      }
      resolve({ stderr, stdout })
    })
  })
  await testInfo.attach(`${scenario}-verification`, {
    body: Buffer.from(`${stdout}${stderr}`),
    contentType: 'text/plain',
  })
}

function replayEvents(serializedEvidence: string): unknown[] {
  const evidence = parseRecord(serializedEvidence, 'delivery evidence')
  const receipts = evidence['receipts']
  if (!Array.isArray(receipts)) {
    throw new Error('delivery evidence has no receipts')
  }
  return receipts
    .map((value) => {
      if (!isRecord(value) || typeof value['body'] !== 'string' || typeof value['seq'] !== 'number') {
        throw new Error('delivery evidence contains an invalid receipt')
      }
      return { body: value['body'], seq: value['seq'] }
    })
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
