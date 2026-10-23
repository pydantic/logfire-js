import { expect, test } from '@playwright/test'

test.describe('browser frustration playground', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install()
    await page.goto('http://127.0.0.1:5189/')
    await expect(page.getByRole('heading', { name: 'Find the clicks that go nowhere.' })).toBeVisible()
  })

  test('three trusted clicks emit one visible rage episode', async ({ page }) => {
    const button = page.getByRole('button', { name: 'Try again' })
    await button.click({ clickCount: 3, delay: 100 })
    await expect(page.getByText('Rapid repeated clicks', { exact: true })).toHaveCount(1)
    await button.click()
    await expect(page.getByText('Rapid repeated clicks', { exact: true })).toHaveCount(1)
    await page.screenshot({ path: test.info().outputPath('desktop.png'), fullPage: true })
  })

  test('a quick successful response stays quiet', async ({ page }) => {
    await page.getByRole('button', { name: 'Save draft' }).click()
    await expect(page.getByText('✓ Draft saved')).toBeVisible()
    await page.evaluate(() => {
      const host = document.createElement('div')
      host.style.cssText = 'position:fixed;top:5px;left:350px;z-index:100'
      document.body.append(host)
      const root = host.attachShadow({ mode: 'open' })
      root.innerHTML = '<button>Shadow save</button><span></span>'
      const button = root.querySelector('button')
      const status = root.querySelector('span')
      button?.addEventListener('click', () => {
        if (status !== null) {
          status.textContent = 'Shadow saved'
        }
      })
    })
    await page.clock.runFor(100)
    await page.getByRole('button', { name: 'Shadow save' }).click()
    await expect(page.getByText('Shadow saved', { exact: true })).toBeVisible()
    await page.clock.runFor(7400)
    await expect(page.getByText('No response observed', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Slow response observed', { exact: true })).toHaveCount(0)
  })

  test('no feedback produces a suspected dead click rather than a slow response', async ({ page }) => {
    await page.getByRole('button', { name: 'Save changes' }).click()
    await page.clock.runFor(7400)
    await expect(page.getByText('No response observed', { exact: true })).toBeVisible({ timeout: 9000 })
    await expect(page.getByText('Slow response observed', { exact: true })).toHaveCount(0)
  })

  test('delayed feedback produces a slow response signal', async ({ page }) => {
    await page.getByRole('button', { name: 'Generate report' }).click()
    await page.clock.runFor(3500)
    await expect(page.getByText('Slow response observed', { exact: true })).toBeVisible()
    await expect(page.getByText('No response observed', { exact: true })).toHaveCount(0)
  })

  test('synthetic clicks do not produce frustration signals', async ({ page }) => {
    await page.getByRole('button', { name: 'Try again' }).evaluate((node) => {
      for (let i = 0; i < 3; i++) {
        ;(node as HTMLButtonElement).click()
      }
    })
    await page.clock.runFor(7400)
    await expect(page.getByText('No signals yet.', { exact: false })).toBeVisible()
  })

  test('excluded controls stay quiet and the mobile layout has no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const button = page.getByRole('button', { name: 'Try again' })
    await button.evaluate((node) => {
      node.setAttribute('data-logfire-ignore-frustration', '')
    })
    await button.click({ clickCount: 3, delay: 100 })
    await page.clock.runFor(7400)
    await expect(page.getByText('No signals yet.', { exact: false })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: test.info().outputPath('mobile.png'), fullPage: true })
  })
})
