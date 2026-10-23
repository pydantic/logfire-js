import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import type { FrustrationFixture } from '../../logfire-browser/test-fixtures/frustration/acceptance.types'

interface ExportedSpan {
  attributes?: { key: string; value: { stringValue?: string; intValue?: string | number; doubleValue?: number } }[]
  name: string
}
interface OtlpRequest {
  resourceSpans?: { scopeSpans?: { spans?: ExportedSpan[] }[] }[]
}

async function start(page: Page, mode = ''): Promise<ExportedSpan[]> {
  const spans: ExportedSpan[] = []
  await page.clock.install()
  await page.route('**/v1/**', async (handler) => {
    const request = handler.request()
    expect(new URL(request.url()).pathname).toBe('/v1/traces')
    if (request.method() === 'POST') {
      const payload = request.postDataJSON() as OtlpRequest
      spans.push(...(payload.resourceSpans ?? []).flatMap((resource) => (resource.scopeSpans ?? []).flatMap((scope) => scope.spans ?? [])))
    }
    await handler.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })
  await page.goto(`http://127.0.0.1:5190/acceptance.html?mode=${mode}`)
  await expect(page.getByText('ready', { exact: true })).toBeVisible()
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100))
  return spans
}

async function finish(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Finish', exact: true }).click()
  await expect(page.getByText('complete', { exact: true })).toBeVisible()
}

function attributes(span: ExportedSpan): Record<string, string | number | undefined> {
  return Object.fromEntries(
    (span.attributes ?? []).map(({ key, value }) => [key, value.stringValue ?? value.intValue ?? value.doubleValue])
  )
}

test.describe('public SDK frustration export', () => {
  test('excludes focusable descendants of an aria-disabled container', async ({ page }) => {
    const spans = await start(page)
    await page.evaluate(() => {
      const container = document.createElement('div')
      container.setAttribute('aria-disabled', 'true')
      container.innerHTML = '<button>Unavailable action</button>'
      document.body.append(container)
    })
    await page.getByRole('button', { name: 'Unavailable action' }).click({ force: true, clickCount: 3, delay: 100 })
    await page.clock.runFor(7400)
    await finish(page)
    expect(spans.filter((span) => span.name.startsWith('browser.'))).toEqual([])
  })

  test('coexists with automatic user-interaction instrumentation without duplicating rage signals', async ({ page }) => {
    const spans = await start(page, 'auto')
    await page.getByRole('button', { name: 'Private checkout label' }).click({ clickCount: 3, delay: 100 })
    await page.clock.runFor(100)
    expect(await page.evaluate(() => window.frustrationFixture.handledClicks)).toBe(3)
    await finish(page)
    expect(spans.filter((span) => span.name === 'browser.rage_click')).toHaveLength(1)
    const ordinaryClicks = spans.filter(
      (span) => attributes(span)['event_type'] === 'click' && attributes(span)['target_xpath'] === '//*[@id="repeat"]'
    )
    expect(ordinaryClicks).toHaveLength(3)
  })

  test('exports a privacy-safe rage signal through the real OTLP exporter', async ({ page }) => {
    const spans = await start(page)
    await page.getByRole('button', { name: 'Private checkout label' }).click({ clickCount: 3, delay: 100 })
    await finish(page)
    const signals = spans.filter((span) => span.name === 'browser.rage_click')
    expect(signals).toHaveLength(1)
    expect(attributes(signals[0] ?? { name: '' })).toMatchObject({
      'logfire.interaction.click_count': 3,
      'logfire.interaction.response': 'not_assessed',
      'logfire.page.route': '/checkout',
      'logfire.interaction.target_tag': 'button',
    })
    expect(JSON.stringify(spans)).not.toContain('Private checkout label')
    expect(JSON.stringify(spans)).not.toContain('secret-input-value')
  })

  test('retains original context when page grouping changes before classification', async ({ page }) => {
    const spans = await start(page)
    const session: ReturnType<FrustrationFixture['session']> = await page.evaluate(() => window.frustrationFixture.session())
    await page.getByRole('button', { name: 'Slow action' }).click()
    await page.evaluate(() => {
      window.frustrationFixture.setRoute('/later-page')
    })
    await page.clock.runFor(3500)
    await finish(page)
    const signals = spans.filter((span) => span.name === 'browser.slow_click')
    expect(signals).toHaveLength(1)
    expect(attributes(signals[0] ?? { name: '' })).toMatchObject({ 'session.id': session, 'logfire.page.route': '/checkout' })
  })

  for (const mode of ['errors', 'drop']) {
    test(`respects ${mode} sampling instead of marking frustration as an error`, async ({ page }) => {
      const spans = await start(page, mode)
      await page.getByRole('button', { name: 'Private checkout label' }).click({ clickCount: 3, delay: 100 })
      await finish(page)
      expect(spans.filter((span) => span.name.startsWith('browser.'))).toEqual([])
    })
  }

  test('an explicit tail override retains frustration in the errors profile', async ({ page }) => {
    const spans = await start(page, 'keep')
    await page.getByRole('button', { name: 'Private checkout label' }).click({ clickCount: 3, delay: 100 })
    await finish(page)
    expect(spans.filter((span) => span.name === 'browser.rage_click')).toHaveLength(1)
  })

  test('session rollover discards pending observations without misattribution', async ({ page }) => {
    const spans = await start(page)
    const original = await page.evaluate(() => window.frustrationFixture.session())
    await page.getByRole('button', { name: 'Private checkout label' }).click()
    await page.clock.fastForward(31 * 60000)
    const next = await page.evaluate(() => window.frustrationFixture.session())
    expect(next).not.toBe(original)
    await page.clock.runFor(8000)
    await finish(page)
    expect(spans.filter((span) => span.name.startsWith('browser.'))).toEqual([])
  })
})

test.describe('frustration target eligibility', () => {
  test('resolves clicks on nested text and SVG children to one interactive control', async ({ page }) => {
    const spans = await start(page)
    await page.evaluate(() => {
      const button = document.createElement('button')
      button.setAttribute('aria-label', 'Nested action')
      button.style.cssText = 'display:flex;gap:0;padding:0'
      button.innerHTML =
        '<span style="width:12px;height:12px">A</span><svg width="12" height="12" role="img" aria-label="Nested icon"><rect width="12" height="12"/></svg>'
      document.body.append(button)
    })
    const button = page.getByRole('button', { name: 'Nested action' })
    await button.getByText('A', { exact: true }).click()
    await button.getByRole('img', { name: 'Nested icon' }).click()
    await button.getByText('A', { exact: true }).click()
    await finish(page)
    const rage = spans.filter(({ name }) => name === 'browser.rage_click')
    expect(rage).toHaveLength(1)
    expect(attributes(rage[0] ?? { name: '' })['logfire.interaction.target_tag']).toBe('button')
  })

  test('modifier and non-primary clicks do not create rage or dead candidates', async ({ page }) => {
    const spans = await start(page)
    const button = page.getByRole('button', { name: 'Private checkout label' })
    await button.click({ modifiers: ['Shift'], clickCount: 3, delay: 100 })
    await button.click({ modifiers: ['Alt'], clickCount: 3, delay: 100 })
    await button.click({ modifiers: ['Meta'], clickCount: 3, delay: 100 })
    await button.click({ modifiers: ['Control'], clickCount: 3, delay: 100 })
    await button.click({ button: 'middle' })
    await button.click({ button: 'right' })
    await page.keyboard.press('Escape')
    await page.clock.runFor(7400)
    await finish(page)
    expect(spans.filter(({ name }) => name.startsWith('browser.'))).toEqual([])
  })

  test('custom ancestor exclusions and noninteractive elements stay quiet', async ({ page }) => {
    const spans = await start(page)
    await page.evaluate(() => {
      const section = document.createElement('section')
      section.innerHTML = '<div data-no-frustration><button>Excluded nested action</button></div><div>Noninteractive text</div>'
      document.body.append(section)
    })
    await page.getByRole('button', { name: 'Excluded nested action' }).click({ clickCount: 3, delay: 100 })
    await page.getByText('Noninteractive text', { exact: true }).click({ clickCount: 3, delay: 100 })
    await page.clock.runFor(7400)
    await finish(page)
    expect(spans.filter(({ name }) => name.startsWith('browser.'))).toEqual([])
  })
})

test.describe('frustration navigation boundaries', () => {
  for (const activation of ['pointer with immediate feedback', 'keyboard'] as const) {
    test(`keeps repeated-click detection independent of ${activation}`, async ({ page }) => {
      const spans = await start(page)
      const button = page.getByRole('button', { name: 'Private checkout label' })
      if (activation === 'keyboard') {
        await button.focus()
        await page.keyboard.press('Enter')
        await page.keyboard.press('Enter')
        await page.keyboard.press('Enter')
      } else {
        await button.evaluate((node) => {
          node.addEventListener('click', () => {
            node.setAttribute('aria-pressed', node.getAttribute('aria-pressed') === 'true' ? 'false' : 'true')
          })
        })
        await button.click()
        await button.click()
        await button.click()
      }
      await finish(page)
      expect(spans.filter(({ name }) => name === 'browser.rage_click')).toHaveLength(1)
    })
  }

  for (const intent of ['pointer', 'keyboard', 'wheel'] as const) {
    test(`new ${intent} intent does not classify the preceding click as a slow response`, async ({ page }) => {
      const spans = await start(page)
      await page.evaluate(() => {
        document.body.style.minHeight = '3000px'
      })
      await page.getByRole('button', { name: 'Private checkout label' }).click()
      await page.clock.runFor(3500)
      if (intent === 'pointer') {
        await page.getByRole('textbox').click()
      } else if (intent === 'keyboard') {
        await page.keyboard.press('Tab')
      } else {
        await page.mouse.wheel(0, 200)
        await expect.poll(async () => page.evaluate(() => scrollY)).toBeGreaterThan(0)
      }
      await page.clock.runFor(4000)
      await finish(page)
      expect(spans.filter((span) => span.name.startsWith('browser.'))).toEqual([])
    })
  }

  test('programmatic focus after a click remains application feedback', async ({ page }) => {
    const spans = await start(page)
    await page.getByRole('button', { name: 'Private checkout label' }).click()
    await page.clock.runFor(3500)
    await page.getByRole('textbox').evaluate((node) => {
      node.focus()
    })
    await page.clock.runFor(4000)
    await finish(page)
    const signals = spans.filter((span) => span.name.startsWith('browser.'))
    expect(signals.map(({ name }) => name)).toEqual(['browser.slow_click'])
    expect(attributes(signals[0] ?? { name: '' })['logfire.interaction.response']).toBe('focusin')
  })

  test('navigation from a customer span processor does not resurrect an old observation', async ({ page }) => {
    const spans = await start(page, 'navigation-during-report')
    await page.getByRole('button', { name: 'Private checkout label' }).click({ clickCount: 3, delay: 100 })
    await page.clock.runFor(7400)
    await finish(page)
    expect(spans.filter((span) => span.name.startsWith('browser.')).map(({ name }) => name)).toEqual(['browser.rage_click'])
  })

  test('native scroll feedback inside an open shadow root is a slow response, not a dead click', async ({ page }) => {
    const spans = await start(page)
    await page.evaluate(() => {
      const host = document.createElement('div')
      host.style.cssText = 'position:fixed;bottom:0;left:0;height:200px;background:white;z-index:10'
      const root = host.attachShadow({ mode: 'open' })
      root.innerHTML =
        '<button>Scroll shadow content</button><div style="height:100px;overflow:auto"><div style="height:500px"></div></div>'
      const scroller = root.querySelector('div')
      const button = root.querySelector('button')
      if (scroller === null || button === null) {
        throw new Error('Shadow fixture elements missing')
      }
      root.addEventListener(
        'scroll',
        () => {
          window.frustrationFixture.scrollEvents = (window.frustrationFixture.scrollEvents ?? 0) + 1
        },
        true
      )
      button.addEventListener('click', () => {
        setTimeout(() => {
          scroller.scrollTop = 150
        }, 3400)
      })
      document.body.append(host)
    })
    await page.getByRole('button', { name: 'Scroll shadow content' }).click()
    await page.clock.runFor(3500)
    await expect.poll(async () => page.evaluate(() => window.frustrationFixture.scrollEvents)).toBe(1)
    await page.clock.runFor(3900)
    await finish(page)
    expect(spans.filter((span) => span.name === 'browser.slow_click')).toHaveLength(1)
    expect(spans.filter((span) => span.name === 'browser.dead_click')).toEqual([])
  })

  test('discards a candidate when history navigates away and back before classification', async ({ page }) => {
    const spans = await start(page)
    await page.getByRole('button', { name: 'Private checkout label' }).click()
    await page.evaluate(() => {
      const original = location.href
      history.pushState({}, '', '/other-page')
      history.replaceState({}, '', original)
    })
    await page.clock.runFor(7100)
    await finish(page)
    expect(spans.filter((span) => span.name.startsWith('browser.'))).toEqual([])
  })

  test('a rejected history navigation does not erase a valid pending candidate', async ({ page }) => {
    const spans = await start(page)
    await page.getByRole('button', { name: 'Private checkout label' }).click()
    const rejected = await page.evaluate(() => {
      try {
        history.pushState({}, '', 'https://not-this-origin.invalid/')
      } catch {
        return true
      }
      return false
    })
    expect(rejected).toBe(true)
    await page.clock.runFor(7100)
    await finish(page)
    expect(spans.filter((span) => span.name === 'browser.dead_click')).toHaveLength(1)
  })
})
