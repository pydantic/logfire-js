import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import type { Receipts } from '../../../examples/browser/quick-redirect/vite.config'

const origin = 'http://127.0.0.1:4194'

for (const { mode, persistence } of [
  { mode: 'stay', persistence: 'on' },
  { mode: 'redirect', persistence: 'on' },
  { mode: 'in-flight', persistence: 'on' },
  { mode: 'stay', persistence: 'off' },
]) {
  test(`resource spans reach the collector: ${mode}, persistence ${persistence}`, async ({ page, request }, testInfo) => {
    const run = randomUUID()
    const evidence = async (): Promise<Receipts> => {
      const response = await request.get(`http://127.0.0.1:4195/receipts/${run}`)
      expect(response.ok()).toBe(true)
      return (await response.json()) as Receipts
    }
    await page.goto(`${origin}/?run=${run}&mode=${mode}&persistence=${persistence}`)
    if (mode !== 'stay') {
      await page.waitForURL(`**/?run=${run}&destination=1`)
      await expect(page.getByRole('status')).toHaveText('Destination loaded')
    }
    const created = async () => page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? '[]') as string[], `quick-redirect:${run}`)
    // Prove these spans ended before navigation; this is not the separate pre-load loss case.
    await expect.poll(created).toHaveLength(250)
    const expected = await created()
    expect(expected).toHaveLength(250)
    expect(new Set(expected).size).toBe(250)
    if (persistence === 'off') {
      await expect(page.getByRole('status')).toHaveText('Exporting without navigation')
      expect(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('logfire:traces:')))).toEqual([])
    }
    const received = async () => {
      const receipts = await evidence()
      return [...new Set(receipts.spans.filter((span) => expected.includes(span.spanId)).map((span) => span.spanId))].sort()
    }
    try {
      await expect
        .poll(received, { message: 'Every resource span created by the source page must reach the collector' })
        .toEqual([...expected].sort())
      if (mode === 'stay') {
        await expect(page.getByRole('status')).toHaveText('Export complete')
        expect((await evidence()).uploads.some((upload) => upload.complete && upload.bytes > 64 * 1024)).toBe(true)
      }
      await expect
        .poll(async () => page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('logfire:traces:')).length))
        .toBe(0)
    } finally {
      const path = testInfo.outputPath('collector-receipts.json')
      await writeFile(path, JSON.stringify({ expected, received: await evidence() }, null, 2))
      await testInfo.attach('collector-receipts', {
        path,
        contentType: 'application/json',
      })
    }
  })
}
