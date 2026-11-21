/**
 * @vitest-environment jsdom
 */
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { createMemoryHistory, createRouter, createWebHashHistory, createWebHistory } from 'vue-router'
import type { RouterHistory } from 'vue-router'

import { clearConfiguredBrowserSessionForTests } from './browserSession'
import { configure, startSpan } from './index'
import { vueRouterRouteName } from './vueRouter'
import type { VueRouterLike } from './vueRouter'

vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class {
    export(_spans: unknown, resultCallback: (result: { code: number }) => void): void {
      resultCallback({ code: 0 })
    }

    async shutdown(): Promise<void> {
      return Promise.resolve()
    }
  },
}))

// Each web history listens to popstate, so remove them after each test.
const histories: RouterHistory[] = []
const component = {}

function createTestRouter(history: RouterHistory = createWebHistory()) {
  const pendingGuards: (() => void)[] = []
  histories.push(history)
  const router = createRouter({
    history,
    routes: [
      { component, path: '/' },
      {
        children: [
          { component, path: '' },
          {
            alias: '/p/:id',
            beforeEnter: async (to) => {
              if (to.params['id'] === 'slow') {
                await new Promise<void>((resolve) => {
                  pendingGuards.push(resolve)
                })
              }
              return true
            },
            component,
            path: ':id',
          },
        ],
        component,
        path: '/projects',
      },
      { component, path: '/settings' },
      { component, path: '/files/:rest(.*)*' },
      { path: '/legacy/:id', redirect: (to) => `/projects/${String(to.params['id'])}` },
    ],
  })
  return { pendingGuards, router }
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  for (const history of histories.splice(0)) {
    history.destroy()
  }
  clearConfiguredBrowserSessionForTests()
  sessionStorage.clear()
  vi.restoreAllMocks()
})

describe('vueRouterRouteName', () => {
  it('reports one template for every URL of a dynamic route', async () => {
    window.history.replaceState(null, '', '/projects/123')
    const { router } = createTestRouter()
    const getRouteName = vueRouterRouteName(router)

    expect(getRouteName()).toBe('/projects/:id')
    await router.push('/projects/456')
    expect(getRouteName()).toBe('/projects/:id')
  })

  it.each([
    ['/', '/'],
    ['/projects', '/projects'],
    ['/settings', '/settings'],
    ['/files/a/b/c', '/files/:rest(.*)*'],
    ['/p/7', '/projects/:id'],
    ['/settings?tab=billing#plan', '/settings'],
  ])('reports %s as %s', async (href, route) => {
    const { router } = createTestRouter()
    const getRouteName = vueRouterRouteName(router)

    await router.push(href)

    expect(getRouteName()).toBe(route)
  })

  it('reports a URL that no route matches as /*', async () => {
    // Vue Router warns in development builds about a location without a route.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { router } = createTestRouter()
    const getRouteName = vueRouterRouteName(router)

    await router.push('/unknown/42')

    expect(getRouteName()).toBe('/*')
  })

  it('matches the route table without the history base', async () => {
    window.history.replaceState(null, '', '/app/projects/123')
    const { router } = createTestRouter(createWebHistory('/app'))
    const getRouteName = vueRouterRouteName(router)

    expect(getRouteName()).toBe('/projects/:id')
    await router.push('/settings')
    expect(window.location.pathname).toBe('/app/settings')
    expect(getRouteName()).toBe('/settings')
  })

  it('reports the destination of a back navigation while its guard runs', async () => {
    const { pendingGuards, router } = createTestRouter()
    const getRouteName = vueRouterRouteName(router)
    const slow = router.push('/projects/slow')
    await vi.waitFor(() => {
      expect(pendingGuards).toHaveLength(1)
    })
    pendingGuards.shift()?.()
    await slow
    await router.push('/settings')

    router.back()
    await vi.waitFor(() => {
      expect(pendingGuards).toHaveLength(1)
    })

    expect(window.location.pathname).toBe('/projects/slow')
    expect(router.currentRoute.value.path).toBe('/settings')
    expect(getRouteName()).toBe('/projects/:id')
    pendingGuards.shift()?.()
    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe('/projects/slow')
    })
  })

  it('reports the redirect target', async () => {
    const { router } = createTestRouter()
    const getRouteName = vueRouterRouteName(router)

    await router.push('/legacy/9')

    expect(window.location.pathname).toBe('/projects/9')
    expect(getRouteName()).toBe('/projects/:id')
  })

  it.each([
    ['hash', () => createWebHashHistory()],
    ['memory', () => createMemoryHistory()],
  ])('reports routes with %s history', async (_name, createHistory) => {
    const { router } = createTestRouter(createHistory())
    const getRouteName = vueRouterRouteName(router)

    await router.push('/projects/1')
    expect(getRouteName()).toBe('/projects/:id')
    await router.push('/settings')
    expect(getRouteName()).toBe('/settings')
  })

  it('resolves each location once per router', async () => {
    const { router } = createTestRouter()
    const resolved: string[] = []
    const countingRouter = (): VueRouterLike => ({
      options: router.options,
      resolve: (to) => {
        resolved.push(to)
        return router.resolve(to)
      },
    })
    let current = countingRouter()
    const getRouteName = vueRouterRouteName(() => current)

    getRouteName()
    getRouteName()
    await router.push('/projects/1')
    getRouteName()
    getRouteName()
    current = countingRouter()
    getRouteName()

    expect(resolved).toEqual(['/', '/projects/1', '/projects/1'])
  })

  it('reports no route until a lazily created router exists', () => {
    const app: { router?: ReturnType<typeof createTestRouter>['router'] } = {}
    const getRouteName = vueRouterRouteName(() => app.router)

    expect(getRouteName()).toBeUndefined()
    window.history.replaceState(null, '', '/settings')
    app.router = createTestRouter().router
    expect(getRouteName()).toBe('/settings')
  })

  it('labels SDK spans with the route of their page', async () => {
    const exporter = new InMemorySpanExporter()
    const { router } = createTestRouter()
    const cleanup = configure({
      rum: { session: { getRouteName: vueRouterRouteName(router) } },
      spanProcessors: [new SimpleSpanProcessor(exporter)],
      traceUrl: '/client-traces',
    })

    try {
      await router.push('/projects/1')
      startSpan('first project').end()
      await router.push('/projects/2')
      startSpan('second project').end()

      const pages = Object.fromEntries(
        exporter
          .getFinishedSpans()
          .map((span) => [span.name, [span.attributes['logfire.page.url.path'], span.attributes['logfire.page.route']]])
      )
      expect(pages).toEqual({
        'first project': ['/projects/1', '/projects/:id'],
        'second project': ['/projects/2', '/projects/:id'],
      })
    } finally {
      await cleanup()
    }
  })
})
