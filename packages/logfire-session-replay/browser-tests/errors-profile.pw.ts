import { gunzipSync } from 'node:zlib'

import { expect, test } from '@playwright/test'

const fixtureOrigin = 'http://127.0.0.1:4184'

interface Receipt {
  body: string
  kind: 'trace' | 'metric' | 'replay'
  url: string
}

interface OtlpValue {
  boolValue?: boolean
  doubleValue?: number
  intValue?: number | string
  stringValue?: string
}

interface OtlpSpan {
  attributes?: { key: string; value: OtlpValue }[]
  name: string
  parentSpanId?: string
  spanId: string
  traceId: string
}

interface ReplayEvent {
  data?: { payload?: { message?: string }; tag?: string }
  type: number
}

test('the errors profile exports failed traces and one promoted replay with both errors', async ({ page, request }) => {
  expect((await request.post(`${fixtureOrigin}/receipts/reset`)).ok()).toBe(true)
  await page.goto(`${fixtureOrigin}/`)
  await expect(page.locator('#status')).toHaveText('ready')

  await page.locator('#healthy').click()
  await page.locator('#handled').click()
  await page.locator('#failed-request').click()
  await page.locator('#uncaught').click()
  // Fetch instrumentation waits briefly for resource-timing entries before ending its spans.
  await page.waitForTimeout(1_000)
  await page.locator('#finish').click()
  await expect(page.locator('#status')).toHaveText('complete')

  const response = await request.get(`${fixtureOrigin}/receipts`)
  expect(response.ok()).toBe(true)
  const { receipts } = (await response.json()) as { receipts: Receipt[] }
  const spans = receipts
    .filter(({ kind }) => kind === 'trace')
    .flatMap(({ body }) => {
      const payload = JSON.parse(Buffer.from(body, 'base64').toString('utf8')) as {
        resourceSpans?: { scopeSpans?: { spans?: OtlpSpan[] }[] }[]
      }
      return (payload.resourceSpans ?? []).flatMap(({ scopeSpans }) => (scopeSpans ?? []).flatMap(({ spans: scoped }) => scoped ?? []))
    })

  const handled = spans.find(({ name }) => name === 'Checkout failed')
  const uncaught = spans.find(({ name }) => name === 'Uncaught error')
  const failedRequest = spans.find((span) => numberAttribute(span, 'http.status_code') === 500)
  expect(stringAttribute(handled, 'exception.message')).toBe('handled verification')
  expect(stringAttribute(uncaught, 'exception.message')).toBe('uncaught verification')
  // The click that led to each failure is exported with it.
  expect(parentName(spans, handled)).toMatch(/^click/u)
  expect(parentName(spans, failedRequest)).toMatch(/^click/u)
  // Healthy traces and performance signals stay in the browser.
  expect(spans.filter(({ name }) => name === 'healthy click')).toEqual([])
  expect(spans.filter((span) => numberAttribute(span, 'http.status_code') === 200)).toEqual([])
  expect(spans.filter(({ name }) => name.startsWith('web_vital.') || name === 'documentLoad')).toEqual([])
  expect(receipts.filter(({ kind }) => kind === 'metric')).toEqual([])

  const sessionId = stringAttribute(handled, 'session.id')
  const replayEvents = receipts
    .filter(({ kind, url }) => kind === 'replay' && new URL(url, fixtureOrigin).pathname === `/v1/replay/${String(sessionId)}`)
    .flatMap(({ body }) => (JSON.parse(gunzipSync(Buffer.from(body, 'base64')).toString('utf8')) as { events: ReplayEvent[] }).events)
  const errorMessages = replayEvents
    .filter(({ data, type }) => type === 5 && data?.tag === 'logfire.error')
    .map(({ data }) => data?.payload?.message)
  expect(errorMessages).toEqual(['handled verification', 'uncaught verification'])
  // The buffered replay is playable: it starts from a full snapshot.
  expect(replayEvents.some(({ type }) => type === 2)).toBe(true)
})

function attributeValue(span: OtlpSpan | undefined, key: string): OtlpValue | undefined {
  return span?.attributes?.find((attribute) => attribute.key === key)?.value
}

function stringAttribute(span: OtlpSpan | undefined, key: string): string | undefined {
  return attributeValue(span, key)?.stringValue
}

function numberAttribute(span: OtlpSpan | undefined, key: string): number | undefined {
  const value = attributeValue(span, key)
  return value?.intValue === undefined ? value?.doubleValue : Number(value.intValue)
}

function parentName(spans: OtlpSpan[], span: OtlpSpan | undefined): string | undefined {
  return spans.find(({ spanId, traceId }) => traceId === span?.traceId && spanId === span.parentSpanId)?.name
}
