import { gunzipSync } from 'node:zlib'

import { expect, test } from '@playwright/test'

const origin = 'http://127.0.0.1:4184'

interface Receipt {
  body: string
  kind: 'trace' | 'metric' | 'replay'
  url: string
}

interface Span {
  attributes?: { key: string; value: { stringValue?: string } }[]
  name: string
}

for (const scenario of ['start', 'errors', 'replay'] as const) {
  test(`copied ${scenario} documentation setup sends the expected telemetry`, async ({ page, request }) => {
    expect((await request.post(`${origin}/receipts/reset`)).ok()).toBe(true)
    const uploads: { url: string; authorization: string | undefined }[] = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/v1/')) {
        uploads.push({ url: request.url(), authorization: request.headers()['authorization'] })
      }
    })
    await page.goto(`${origin}/docs/${scenario}.html`)
    await expect(page.getByText('ready', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Healthy click', exact: true }).click()
    // Preserve the documented/default minimum duration, rather than overriding
    // it to zero as the faster behavior fixtures do.
    if (scenario !== 'start') {
      await page.waitForTimeout(10_100)
    }
    await page.getByRole('button', { name: 'Handled error', exact: true }).click()
    await page.getByRole('button', { name: 'Uncaught error', exact: true }).click()
    await expect
      .poll(async () => {
        const { receipts } = (await (await request.get(`${origin}/receipts`)).json()) as { receipts: Receipt[] }
        return spansFrom(receipts).some(({ name }) => name === 'Uncaught error')
      })
      .toBe(true)
    await page.getByRole('button', { name: 'Finish', exact: true }).click()
    await expect(page.getByText('complete', { exact: true })).toBeVisible()

    const { receipts } = (await (await request.get(`${origin}/receipts`)).json()) as { receipts: Receipt[] }
    const spans = spansFrom(receipts)
    expect(spans.filter(({ name }) => name === 'Checkout failed')).toHaveLength(1)
    expect(spans.filter(({ name }) => name === 'Uncaught error')).toHaveLength(1)
    expect(spans.some(({ name }) => name === 'healthy docs click')).toBe(scenario !== 'errors')
    expect(spans.some(({ name }) => name === 'documentLoad')).toBe(scenario !== 'errors')
    expect(uploads.length).toBeGreaterThan(0)
    expect(uploads.every(({ url }) => new URL(url).origin === origin)).toBe(true)
    expect([...new Set(uploads.map(({ authorization }) => authorization))]).toEqual(['Bearer fixture-frontend-token'])
    const replayReceipts = receipts.filter(({ kind }) => kind === 'replay')
    if (scenario === 'start') {
      expect(replayReceipts).toEqual([])
    } else {
      expect(replayReceipts.length).toBeGreaterThan(0)
      const handled = spans.find(({ name }) => name === 'Checkout failed')
      const recordingId = handled?.attributes?.find(({ key }) => key === 'logfire.session_replay.id')?.value.stringValue
      expect(recordingId).toBeDefined()
      expect(replayReceipts.every(({ url }) => new URL(url, origin).pathname === `/v1/replay/${String(recordingId)}`)).toBe(true)
      const replay = replayReceipts.map(({ body }) => gunzipSync(Buffer.from(body, 'base64')).toString('utf8')).join('\n')
      expect(replay).not.toContain('Private checkout text')
      const events = replayReceipts.flatMap(({ body }) => {
        const payload = JSON.parse(gunzipSync(Buffer.from(body, 'base64')).toString('utf8')) as {
          events: { data?: { tag?: string; payload?: { message?: string } }; type: number }[]
        }
        return payload.events
      })
      expect(events.some(({ type }) => type === 2)).toBe(true)
      expect(events.filter(({ data }) => data?.tag === 'logfire.error').map(({ data }) => data?.payload?.message)).toEqual([
        'docs handled',
        'docs uncaught',
      ])
    }
    if (scenario === 'errors') {
      expect(receipts.filter(({ kind }) => kind === 'metric')).toEqual([])
      expect(spans.filter(({ name }) => name.startsWith('web_vital.'))).toEqual([])
    }
  })
}

function spansFrom(receipts: Receipt[]): Span[] {
  return receipts
    .filter(({ kind }) => kind === 'trace')
    .flatMap(({ body }) => {
      const payload = JSON.parse(Buffer.from(body, 'base64').toString('utf8')) as {
        resourceSpans?: { scopeSpans?: { spans?: Span[] }[] }[]
      }
      return (payload.resourceSpans ?? []).flatMap(({ scopeSpans }) => (scopeSpans ?? []).flatMap(({ spans }) => spans ?? []))
    })
}
