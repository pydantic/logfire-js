/* eslint-disable no-await-in-loop -- Paired measurements, ordered outages, and lifecycle cycles must run sequentially. */
import { expect, test } from '@playwright/test'
import type { CDPSession, Page } from '@playwright/test'
import type { FrustrationReceipts } from '../../logfire-browser/test-fixtures/frustration/receipts.types'
import type { FrustrationSafety } from './frustration-safety.types'

async function sample(cdp: CDPSession) {
  await cdp.send('HeapProfiler.collectGarbage')
  const heap = await cdp.send('Runtime.getHeapUsage')
  const dom = await cdp.send('Memory.getDOMCounters')
  const performance = await cdp.send('Performance.getMetrics')
  const taskSeconds = performance.metrics.find(({ name }) => name === 'TaskDuration')?.value
  if (taskSeconds === undefined) {
    throw new Error('Chromium did not provide TaskDuration')
  }
  return {
    heapBytes: heap.usedSize,
    nodes: dom.nodes,
    listeners: dom.jsEventListeners,
    taskSeconds,
  }
}

async function ready(page: Page, enabled: boolean, detectorOnly = false): Promise<ReturnType<FrustrationSafety['recording']>> {
  await page.goto(
    `http://127.0.0.1:5190/safety.html?frustration=${enabled ? 'on' : 'off'}&lifecycle=${detectorOnly ? 'detector' : 'combined'}`
  )
  await expect(page.getByRole('status')).toHaveText('ready')
  if (!detectorOnly) {
    await expect.poll(async () => page.evaluate(() => window.frustrationSafety.recording())).not.toBeUndefined()
  }
  return page.evaluate(() => window.frustrationSafety.recording())
}

async function save(page: Page, index: number): Promise<void> {
  await page.getByRole('button', { name: index % 2 === 0 ? 'Save immediately' : 'Save immediately again', exact: true }).click()
}

test('paired CPU-throttled replay workload survives short and over-budget network outages', async ({ browser, request }, testInfo) => {
  const duration = Number(process.env['FRUSTRATION_SOAK_MS'] ?? 180000)
  if (!Number.isFinite(duration) || duration < 90000 || duration > 600000) {
    throw new Error('FRUSTRATION_SOAK_MS must be between 90000 and 600000')
  }
  test.setTimeout(2 * duration + 180000)
  const results = []
  for (const enabled of [false, true]) {
    await request.post('http://127.0.0.1:5190/fixture/reset')
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', (error) => {
        errors.push(error.message)
      })
      const cdp = await context.newCDPSession(page)
      await cdp.send('Performance.enable')
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
      const recording = await ready(page, enabled)
      await page.evaluate(() => {
        window.frustrationSafety.workload(true)
      })
      for (let warmup = 0; warmup < 10; warmup++) {
        await save(page, warmup)
      }
      const before = await sample(cdp)
      const started = Date.now()
      const snapshots = []
      let offline = false
      let clicks = 10
      while (Date.now() - started < duration) {
        const elapsed = Date.now() - started
        // The second outage outlasts the recorder's 30-second retry budget.
        const shouldBeOffline = (elapsed >= 10000 && elapsed < 18000) || (elapsed >= 30000 && elapsed < 75000)
        if (shouldBeOffline !== offline) {
          await context.setOffline(shouldBeOffline)
          offline = shouldBeOffline
        }
        await save(page, clicks)
        clicks++
        if (elapsed >= snapshots.length * 30000) {
          snapshots.push({ elapsed, ...(await sample(cdp)) })
        }
        await page.waitForTimeout(500)
      }
      await context.setOffline(false)
      await page.waitForTimeout(3000)
      await page.evaluate(() => {
        window.frustrationSafety.workload(false)
      })
      await page.getByRole('button', { name: 'Unresponsive action' }).click({ clickCount: 3, delay: 100 })
      await page.evaluate(async () => window.frustrationSafety.stop())
      const after = await sample(cdp)
      const stats = await page.evaluate(() => window.frustrationSafety.stats())
      const result = { enabled, duration, clicks, stats, before, after, snapshots }
      results.push(result)
      await testInfo.attach(enabled ? 'frustration-enabled-soak' : 'frustration-disabled-baseline', {
        body: JSON.stringify(result, null, 2),
        contentType: 'application/json',
      })
      console.log(JSON.stringify({ soakMode: result }))
      expect(stats.handled).toBe(clicks)
      expect(stats.ticks).toBeGreaterThan(duration / 250)
      expect(stats.uploadErrors).toBeGreaterThan(0)
      expect(errors).toEqual([])
      expect(await page.evaluate(() => window.frustrationSafety.signals)).toEqual(enabled ? ['browser.rage_click'] : [])
      expect(after.heapBytes - before.heapBytes).toBeLessThan(8 * 1024 * 1024)
      const response = await request.get('http://127.0.0.1:5190/fixture/receipts')
      expect(response.ok()).toBe(true)
      const evidence = (await response.json()) as FrustrationReceipts
      const chunks = evidence.chunks.filter(({ id }) => id === recording)
      expect(chunks.length).toBeGreaterThan(3)
      expect(new Set(chunks.map(({ seq }) => seq)).size).toBe(chunks.length)
      expect(chunks.at(-1)?.events.some(({ timestamp }) => timestamp > started + 75000)).toBe(true)
      // Lost deltas must be followed by a playable checkpoint, not an unanchored tail.
      const gaps = chunks.filter((chunk, index) => index > 0 && chunk.seq !== (chunks[index - 1]?.seq ?? -1) + 1)
      expect(gaps.length).toBeGreaterThan(0)
      expect(gaps.every(({ events }) => events.some(({ type }) => type === 2))).toBe(true)
      expect(JSON.stringify(chunks)).not.toContain('safety-input-canary')
      await testInfo.attach(enabled ? 'enabled-replay-sequences' : 'baseline-replay-sequences', {
        body: JSON.stringify(chunks.map(({ seq, events }) => ({ seq, hasFullSnapshot: events.some(({ type }) => type === 2) }))),
        contentType: 'application/json',
      })
    } finally {
      await context.close()
    }
  }
  await testInfo.attach('paired-soak', { body: JSON.stringify(results, null, 2), contentType: 'application/json' })
  console.log(JSON.stringify({ pairedFrustrationSoak: results }))
})

test('repeated isolated detector lifecycles release detached shadow targets, DOM nodes, and listeners', async ({ page }, testInfo) => {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  await ready(page, true, true)
  expect(await page.evaluate(() => window.frustrationSafety.recording())).toBeUndefined()
  await page.evaluate(async () => window.frustrationSafety.stop())
  const snapshots = []
  for (let cycle = 0; cycle < 70; cycle++) {
    await page.evaluate(async () => window.frustrationSafety.start())
    await page.evaluate(() => {
      const host = document.createElement('div')
      host.id = 'transient-target'
      const root = host.attachShadow({ mode: 'open' })
      const button = document.createElement('button')
      button.textContent = 'Transient action'
      root.append(button)
      document.body.append(host)
    })
    await page.getByRole('button', { name: 'Transient action', exact: true }).click()
    await page.evaluate(async () => window.frustrationSafety.stop())
    await page.evaluate(() => document.querySelector('#transient-target')?.remove())
    if (cycle === 9 || cycle === 39 || cycle === 69) {
      snapshots.push(await sample(cdp))
    }
  }
  const first = snapshots[0]
  const last = snapshots[2]
  expect(first).toBeDefined()
  expect(last).toBeDefined()
  if (first === undefined || last === undefined) {
    throw new Error('Missing lifecycle measurements')
  }
  expect(last.listeners).toBeLessThanOrEqual(first.listeners + 5)
  expect(last.nodes).toBeLessThanOrEqual(first.nodes + 30)
  expect(last.heapBytes - first.heapBytes).toBeLessThan(2 * 1024 * 1024)
  await testInfo.attach('lifecycle-retention', { body: JSON.stringify(snapshots, null, 2), contentType: 'application/json' })
  console.log(JSON.stringify({ lifecycleRetention: snapshots }))
})
