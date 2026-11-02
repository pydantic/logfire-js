import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { expect, test } from '@playwright/test'

const fixtureOrigin = 'http://127.0.0.1:4192'
// The platform's source map resolver tests read this captured export.
const capturedExportPath = resolve(import.meta.dirname, '../../../test-results/debug-ids/otlp-browser-exception.json')

interface OtlpAttribute {
  key: string
  value: { stringValue?: string }
}

interface OtlpSpan {
  attributes?: OtlpAttribute[]
  events?: { attributes?: OtlpAttribute[]; name: string }[]
  name: string
}

interface OtlpExport {
  resourceSpans?: { resource?: { attributes?: OtlpAttribute[] }; scopeSpans?: { spans?: OtlpSpan[] }[] }[]
}

function stringAttribute(attributes: OtlpAttribute[] | undefined, key: string): string | undefined {
  return attributes?.find((attribute) => attribute.key === key)?.value.stringValue
}

function spansOf(payload: OtlpExport): OtlpSpan[] {
  return (payload.resourceSpans ?? []).flatMap(({ scopeSpans }) => (scopeSpans ?? []).flatMap(({ spans }) => spans ?? []))
}

test('an uncaught error exports the debug IDs of the injected bundles in its stack and the injected release', async ({ page, request }) => {
  expect((await request.post(`${fixtureOrigin}/receipts/reset`)).ok()).toBe(true)
  await page.goto(`${fixtureOrigin}/`)
  await expect(page.locator('#status')).toHaveText('ready')

  await page.locator('#uncaught').click()
  await page.waitForTimeout(300)
  await page.locator('#finish').click()
  await expect(page.locator('#status')).toHaveText('complete')

  const { receipts } = (await (await request.get(`${fixtureOrigin}/receipts`)).json()) as { receipts: { body: string }[] }
  const payloads = receipts.map(({ body }) => JSON.parse(Buffer.from(body, 'base64').toString('utf8')) as OtlpExport)
  const payload = payloads.find((candidate) => spansOf(candidate).some(({ name }) => name === 'Uncaught error'))
  const uncaught = spansOf(payload ?? {}).find(({ name }) => name === 'Uncaught error')

  const expectedDebugIds = JSON.stringify({
    [`${fixtureOrigin}/checkout-bundle.js`]: '5b1c2a7e-8f4d-4e3b-9a61-0c2d3e4f5a6b',
    [`${fixtureOrigin}/main.ts`]: '2a4c6e8f-1b3d-4f5a-8c7e-9d0b1a2c3e4f',
  })
  expect(stringAttribute(uncaught?.attributes, 'logfire.debug_ids')).toBe(expectedDebugIds)
  expect(stringAttribute(uncaught?.events?.find(({ name }) => name === 'exception')?.attributes, 'logfire.debug_ids')).toBe(
    expectedDebugIds
  )
  expect(stringAttribute(payload?.resourceSpans?.[0]?.resource?.attributes, 'service.version')).toBe('2026.11.02-9f3c2ab')
  // The URL policy strips the cache-busting query, so the stack names the same URL as the attribute key.
  expect(stringAttribute(uncaught?.attributes, 'exception.stacktrace')).toContain(`${fixtureOrigin}/checkout-bundle.js:`)

  mkdirSync(resolve(capturedExportPath, '..'), { recursive: true })
  writeFileSync(capturedExportPath, `${JSON.stringify(payload, null, 2)}\n`)
})
