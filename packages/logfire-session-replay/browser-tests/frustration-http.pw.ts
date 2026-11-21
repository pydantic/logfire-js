import { expect, test } from '@playwright/test'
import type { FrustrationReceipts, FrustrationSpan } from '../../logfire-browser/test-fixtures/frustration/receipts.types'

function attribute(span: FrustrationSpan, key: string): string | number | undefined {
  const value = span.attributes.find((entry) => entry.key === key)?.value
  return value?.stringValue ?? value?.intValue ?? value?.doubleValue
}

test('real HTTP traffic produces correlated signals and a masked replay without interception or a fake clock', async ({
  page,
  request,
  context,
}) => {
  test.setTimeout(45000)
  const errors: string[] = []
  page.on('pageerror', (error) => {
    errors.push(error.message)
  })
  const firstUpload = page.waitForRequest((upload) => upload.method() === 'POST' && new URL(upload.url()).pathname === '/v1/traces')
  await page.goto('http://127.0.0.1:5190/http.html')
  await expect(page.getByText('ready', { exact: true })).toBeVisible()
  const payload = (await firstUpload).postDataJSON() as { resourceSpans: { scopeSpans: { spans: FrustrationSpan[] }[] }[] }
  const initialSpans = payload.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans))
  const sessionId = initialSpans.map((span) => attribute(span, 'session.id')).find((id) => typeof id === 'string')
  expect(typeof sessionId).toBe('string')
  await page.getByRole('textbox', { name: 'Email for your receipt' }).fill('privacy-canary@example.invalid')
  await page.getByRole('button', { name: 'Add to bag', exact: true }).click()
  await expect(page.getByText('✓ Added to your bag', { exact: true })).toBeVisible()
  // Use the actual classification horizon: this intentionally does not install Playwright's clock.
  await page.waitForTimeout(7300)
  await expect(page.getByText('No signals yet.', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Get delivery estimate', exact: true }).click()
  await expect(page.getByText('Free delivery · arrives Thursday', { exact: true })).toBeVisible()
  await expect(page.getByText('Slow response observed', { exact: true })).toHaveCount(1)
  await page.getByRole('button', { name: 'Apply code', exact: true }).click()
  await expect(page.getByText('No response observed', { exact: true })).toHaveCount(1, { timeout: 10000 })
  await page.getByRole('button', { name: 'Retry action', exact: true }).click({ clickCount: 3, delay: 100 })
  await expect(page.getByText('Rapid repeated clicks', { exact: true })).toHaveCount(1)
  let evidence: FrustrationReceipts = { spans: [], chunks: [] }
  const names = ['browser.dead_click', 'browser.rage_click', 'browser.slow_click']
  await expect
    .poll(async () => {
      const response = await request.get('http://127.0.0.1:5190/fixture/receipts')
      expect(response.ok()).toBe(true)
      evidence = (await response.json()) as FrustrationReceipts
      return evidence.spans
        .filter((span) => attribute(span, 'session.id') === sessionId && names.includes(span.name))
        .map((span) => span.name)
        .sort()
    })
    .toEqual(names)
  const signals = evidence.spans.filter((span) => attribute(span, 'session.id') === sessionId && names.includes(span.name))
  for (const signal of signals) {
    const recording = attribute(signal, 'logfire.session_replay.id')
    expect(typeof recording).toBe('string')
    const chunks = evidence.chunks.filter((chunk) => chunk.id === recording)
    expect(chunks.length).toBeGreaterThan(0)
    expect(new Set(chunks.map((chunk) => chunk.seq)).size).toBe(chunks.length)
    expect(chunks.flatMap((chunk) => chunk.events).some((event) => event.type === 2)).toBe(true)
    expect(JSON.stringify(chunks)).not.toContain('privacy-canary@example.invalid')
  }
  await page.getByRole('button', { name: 'Stop SDK', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('SDK stopped')
  const recording = attribute(signals[0] as FrustrationSpan, 'logfire.session_replay.id')
  const events = evidence.chunks
    .filter((chunk) => chunk.id === recording)
    .sort((a, b) => a.seq - b.seq)
    .flatMap((chunk) => chunk.events)
  const playback = await context.newPage()
  try {
    await playback.goto('http://127.0.0.1:4177/playback.html')
    await playback.evaluate(async (recorded) => window.logfireReplayPlayback.load(recorded), events)
    await expect(playback.frameLocator('#replay iframe').getByRole('textbox').first()).toBeVisible()
    await expect(playback.frameLocator('#replay iframe').getByRole('textbox').first()).not.toHaveValue('privacy-canary@example.invalid')
  } finally {
    await playback.close()
  }
  expect(errors).toEqual([])
})
