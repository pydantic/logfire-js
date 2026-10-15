import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// playwright.config.ts points the router examples at this origin. The test
// answers for it, so no telemetry leaves the machine.
const exampleLogfireOrigin = 'http://logfire.test'

interface OtlpAttribute {
  key: string
  value: { stringValue?: string }
}

interface ExportedSpan {
  attributes: Record<string, string | undefined>
  name: string
  start: bigint
}

interface OtlpTraceRequest {
  resourceSpans?: {
    scopeSpans?: { spans?: { attributes?: OtlpAttribute[]; name: string; startTimeUnixNano: string }[] }[]
  }[]
}

const examples = [
  { name: 'React Router', notFound: '/*', port: 4186, project: '/projects/:projectId', projects: '/projects' },
  { name: 'TanStack Router', notFound: '/*', port: 4187, project: '/projects/$projectId', projects: '/projects/' },
  { name: 'Vue Router', notFound: '/:pathMatch(.*)*', port: 4188, project: '/projects/:projectId', projects: '/projects' },
] as const

async function captureSpans(page: Page): Promise<ExportedSpan[]> {
  const spans: ExportedSpan[] = []
  await page.route(`${exampleLogfireOrigin}/**`, async (route) => {
    const request = route.request()
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/v1/traces') {
      const body = request.postDataJSON() as OtlpTraceRequest
      for (const resource of body.resourceSpans ?? []) {
        for (const scope of resource.scopeSpans ?? []) {
          for (const span of scope.spans ?? []) {
            spans.push({
              attributes: Object.fromEntries((span.attributes ?? []).map(({ key, value }) => [key, value.stringValue])),
              name: span.name,
              start: BigInt(span.startTimeUnixNano),
            })
          }
        }
      }
    }
    await route.fulfill({
      body: '{}',
      headers: {
        'access-control-allow-headers': '*',
        'access-control-allow-origin': '*',
        'content-type': 'application/json',
      },
      status: 200,
    })
  })
  return spans
}

function page(span: ExportedSpan): [string | undefined, string | undefined] {
  return [span.attributes['logfire.page.url.path'], span.attributes['logfire.page.route']]
}

for (const example of examples) {
  test(`${example.name} example labels every span with the route of its page`, async ({ page: browserPage }) => {
    // Spans reach the exporter on the SDK's batch schedule.
    test.setTimeout(60_000)
    const spans = await captureSpans(browserPage)
    const expectedRoute = (path: string): string => {
      if (path === '/' || path === '/settings') {
        return path
      }
      if (path === '/projects') {
        return example.projects
      }
      return /^\/projects\/\d+$/u.test(path) ? example.project : example.notFound
    }
    const heading = browserPage.locator('h1')
    const visit = async (link: string, title: string) => {
      await browserPage.getByRole('link', { exact: true, name: link }).click()
      await expect(heading).toHaveText(title)
    }

    await browserPage.goto(`http://127.0.0.1:${String(example.port)}/`)
    await expect(heading).toHaveText('Home')
    await visit('Projects', 'Projects')
    await visit('Project 1', 'Project 1')
    await visit('Project 2', 'Project 2')
    await visit('Settings', 'Settings')
    // Going back loads Project 2 again. Its slow loader or guard fetches while
    // the URL already shows Project 2 and the router still shows Settings.
    await browserPage.goBack()
    await expect(heading).toHaveText('Project 2')
    await visit('Missing page', 'Page not found')

    const pageViews = () =>
      spans
        .filter((span) => span.name === 'page viewed')
        .map(page)
        // React StrictMode runs the page view effect twice in development.
        .filter((view, index, views) => index === 0 || view.join() !== views[index - 1]?.join())
    await expect.poll(pageViews, { timeout: 20_000 }).toEqual([
      ['/', '/'],
      ['/projects', example.projects],
      ['/projects/1', example.project],
      ['/projects/2', example.project],
      ['/settings', '/settings'],
      ['/projects/2', example.project],
      ['/missing/page', example.notFound],
    ])

    const settingsView = spans.find((span) => span.name === 'page viewed' && span.attributes['logfire.page.url.path'] === '/settings')
    const backNavigationFetch = spans.find(
      (span) =>
        settingsView !== undefined &&
        span.start > settingsView.start &&
        Object.values(span.attributes).some((value) => value?.endsWith('/data/projects/2.json') === true)
    )
    expect(backNavigationFetch && page(backNavigationFetch)).toEqual(['/projects/2', example.project])

    const mismatches = spans
      .filter((span) => span.attributes['logfire.page.route'] !== undefined && span.attributes['logfire.page.url.path'] !== undefined)
      .map((span) => ({ name: span.name, page: page(span) }))
      .filter(({ page: [path, route] }) => path !== undefined && route !== expectedRoute(path))
    expect(mismatches).toEqual([])
  })
}
