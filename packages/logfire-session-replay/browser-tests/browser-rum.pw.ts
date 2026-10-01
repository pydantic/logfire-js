import { resolve } from 'node:path'

import { expect, test } from '@playwright/test'

import { repositoryRoot, runVerifier } from './runVerifier'

const rumDimensionsVerifier = resolve(repositoryRoot, 'packages/logfire-browser/test-fixtures/rum-dimensions/verify.mjs')
const softNavigationVerifier = resolve(repositoryRoot, 'packages/logfire-browser/test-fixtures/soft-navigation-web-vitals/verify.mjs')

test.describe('browser RUM dimensions', () => {
  for (const [scenario, path] of [
    ['normal', '/projects/123'],
    ['hostile', '/hostile/'],
  ] as const) {
    test(scenario, async ({ page, request }, testInfo) => {
      // The normal scenario reloads once and waits out a 2s idle rotation.
      test.setTimeout(60_000)
      expect((await request.post('http://127.0.0.1:4180/receipts/reset')).ok()).toBe(true)
      await page.goto(`http://127.0.0.1:4180${path}`)
      await expect(page.locator('#status')).toHaveText(/^(?:complete|failed)$/u, { timeout: 30_000 })
      await expect(page.locator('#status')).toHaveText('complete')
      await runVerifier(rumDimensionsVerifier, scenario, testInfo)
    })
  }
})

test.describe('browser soft-navigation Web Vitals', () => {
  for (const scenario of ['enabled', 'disabled'] as const) {
    test(scenario, async ({ page }, testInfo) => {
      await page.goto(`http://127.0.0.1:4182/?enabled=${String(scenario === 'enabled')}`)
      await expect(page.locator('#status')).toHaveText('ready')
      // Chromium only detects a soft navigation after trusted user input, which
      // a page-dispatched click() does not provide.
      await page.locator('#navigate').click()
      await expect(page.locator('#status')).toHaveText('product')
      // The product navigation needs its own soft-navigation entry before the
      // next click starts another one.
      await page.waitForFunction(() => performance.getEntriesByType('soft-navigation').length > 0)
      // The fixture shows its final status before it publishes the state the
      // verifier reads, so the verifier waits for that upload.
      const statePublished = page.waitForResponse(
        (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/receipts/state'
      )
      await page.locator('#navigate').click()
      await expect(page.locator('#status')).toHaveText(/^(?:complete|failed)$/u)
      await expect(page.locator('#status')).toHaveText('complete')
      await statePublished
      await runVerifier(softNavigationVerifier, scenario, testInfo)
    })
  }
})
