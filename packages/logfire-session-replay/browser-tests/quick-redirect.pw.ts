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
  { mode: 'stay', persistence: 'default' },
  { mode: 'iframe', persistence: 'on' },
  { mode: 'interrupted', persistence: 'on' },
  { mode: 'lost-ack', persistence: 'on' },
]) {
  test(`resource spans reach the collector: ${mode}, persistence ${persistence}`, async ({ page, request }, testInfo) => {
    const run = randomUUID()
    const evidence = async (): Promise<Receipts> => {
      const response = await request.get(`http://127.0.0.1:4195/receipts/${run}`)
      expect(response.ok()).toBe(true)
      return (await response.json()) as Receipts
    }
    const controlled = mode === 'interrupted' || mode === 'lost-ack'
    if (controlled) {
      const response = await request.post(`http://127.0.0.1:4195/scenario/${run}/${mode}`)
      expect(response.ok()).toBe(true)
    }
    await page.goto(`${origin}/?run=${run}&mode=${mode}&persistence=${persistence}`)
    if (controlled) {
      await expect
        .poll(async () => {
          const upload = (await evidence()).uploads.find((item) => item.size > 64 * 1024)
          return mode === 'interrupted' ? upload?.aborted : upload?.complete
        })
        .toBe(true)
      await page.goto(`${origin}/?run=${run}&destination=1`)
      const response = await request.post(`http://127.0.0.1:4195/release/${run}`)
      expect(response.ok()).toBe(true)
    }
    if (mode === 'redirect' || mode === 'in-flight' || controlled) {
      await page.waitForURL(`**/?run=${run}&destination=1`)
      await expect(page.getByRole('status')).toHaveText('Destination loaded')
    }
    const created = async () => page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? '[]') as string[], `quick-redirect:${run}`)
    // Prove these spans ended before navigation; this is not the separate pre-load loss case.
    await expect.poll(created).toHaveLength(250)
    const expected = await created()
    expect(expected).toHaveLength(250)
    expect(new Set(expected).size).toBe(250)
    if (persistence !== 'on') {
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
      if (mode === 'stay' || mode === 'iframe') {
        await expect(page.getByRole('status')).toHaveText('Export complete')
        expect((await evidence()).spans.filter((span) => expected.includes(span.spanId))).toHaveLength(250)
        expect((await evidence()).uploads.some((upload) => upload.complete && upload.bytes > 64 * 1024)).toBe(true)
      }
      await expect
        .poll(async () => page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('logfire:traces:')).length))
        .toBe(0)
      await expect.poll(async () => (await evidence()).uploads.every((upload) => upload.complete || upload.aborted)).toBe(true)
      const receipts = await evidence()
      const copies = (id: string) => receipts.spans.filter((span) => span.spanId === id).length
      const newestId = expected[expected.length - 1]
      const newestUpload = receipts.uploads.find((upload) => upload.spanIds.includes(newestId ?? ''))
      expect(newestUpload).toBeDefined()
      expect(newestUpload?.size).toBeLessThanOrEqual(12_000)
      // Unlike the persisted remainder, the keepalive chunk must never be replayed.
      for (const id of newestUpload?.spanIds ?? []) {
        expect(copies(id)).toBe(1)
      }
      if (mode === 'interrupted') {
        const large = receipts.uploads.filter((upload) => upload.size > 64 * 1024)
        expect(large.map((upload) => upload.complete)).toEqual([false, true])
        expect(large[0]?.bytes).toBe(4096)
        expect(expected.map(copies)).toEqual(expected.map(() => 1))
      } else if (mode === 'lost-ack') {
        const large = receipts.uploads.filter((upload) => upload.size > 64 * 1024)
        expect(large.map((upload) => upload.complete)).toEqual([true, true])
        expect(large[1]?.spanIds).toEqual(large[0]?.spanIds)
        for (const id of large[0]?.spanIds ?? []) {
          expect(copies(id)).toBe(2)
        }
      }
    } finally {
      const path = testInfo.outputPath('collector-receipts.json')
      const receipts = await evidence()
      const resourceSpans = receipts.spans.filter((span) => expected.includes(span.spanId))
      const total = resourceSpans.length
      const unique = new Set(resourceSpans.map((span) => span.spanId)).size
      // Recovery preserves IDs but cannot prevent duplicates after an acknowledgment is lost.
      await writeFile(
        path,
        JSON.stringify({ expected, delivery: { total, unique, duplicates: total - unique }, received: receipts }, null, 2)
      )
      await testInfo.attach('collector-receipts', {
        path,
        contentType: 'application/json',
      })
    }
  })
}
