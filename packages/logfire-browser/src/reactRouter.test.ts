/**
 * @vitest-environment jsdom
 */
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-web'
import { createElement } from 'react'
import { Route, createBrowserRouter, createRoutesFromElements, matchRoutes, redirect } from 'react-router'
import type { RouteObject } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { clearConfiguredBrowserSessionForTests } from './browserSession'
import { configure, startSpan } from './index'
import { reactRouterRouteName } from './reactRouter'

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

const pendingLoaders: (() => void)[] = []
const routers: { dispose: () => void }[] = []

function createRoutes(): RouteObject[] {
  return [
    {
      children: [
        { index: true },
        {
          children: [
            { index: true },
            {
              loader: async ({ params }) => {
                if (params['id'] === 'slow') {
                  await new Promise<void>((resolve) => {
                    pendingLoaders.push(resolve)
                  })
                }
                return null
              },
              path: ':id',
            },
          ],
          path: 'projects',
        },
        { children: [{ path: 'settings' }], id: 'account-layout' },
        { path: 'files/*' },
        { path: 'docs/:lang?/guide' },
        { loader: ({ params }) => redirect(`/projects/${String(params['id'])}`), path: 'legacy/:id' },
      ],
      path: '/',
    },
  ]
}

function createTestRouter(basename?: string) {
  const routes = createRoutes()
  const router = createBrowserRouter(routes, basename === undefined ? {} : { basename })
  routers.push(router)
  return {
    getRouteName: reactRouterRouteName(basename === undefined ? { matchRoutes, routes } : { basename, matchRoutes, routes }),
    router,
  }
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  for (const router of routers.splice(0)) {
    router.dispose()
  }
  pendingLoaders.splice(0)
  clearConfiguredBrowserSessionForTests()
  sessionStorage.clear()
})

describe('reactRouterRouteName', () => {
  it('reports one template for every URL of a dynamic route', async () => {
    window.history.replaceState(null, '', '/projects/123')
    const { getRouteName, router } = createTestRouter()

    expect(getRouteName()).toBe('/projects/:id')
    await router.navigate('/projects/456')
    expect(getRouteName()).toBe('/projects/:id')
  })

  it.each([
    ['/', '/'],
    ['/projects', '/projects'],
    ['/settings', '/settings'],
    ['/files/a/b/c', '/files/*'],
    ['/docs/en/guide', '/docs/:lang?/guide'],
    ['/docs/guide', '/docs/:lang?/guide'],
    ['/settings?tab=billing#plan', '/settings'],
    ['/unknown/42', '/*'],
  ])('reports %s as %s', async (href, route) => {
    const { getRouteName, router } = createTestRouter()

    await router.navigate(href)

    expect(getRouteName()).toBe(route)
  })

  it('reports a catch-all route as /*', async () => {
    const routes: RouteObject[] = [{ children: [{ path: 'settings' }, { path: '*' }], path: '/' }]
    const router = createBrowserRouter(routes)
    routers.push(router)
    const getRouteName = reactRouterRouteName({ matchRoutes, routes })

    await router.navigate('/unknown/42')

    expect(getRouteName()).toBe('/*')
  })

  it('matches the routes without the basename', async () => {
    window.history.replaceState(null, '', '/app/projects/123')
    const { getRouteName, router } = createTestRouter('/app')

    expect(getRouteName()).toBe('/projects/:id')
    await router.navigate('/settings')
    expect(window.location.pathname).toBe('/app/settings')
    expect(getRouteName()).toBe('/settings')
  })

  it('keeps the current route while a pushed navigation loads', async () => {
    const { getRouteName, router } = createTestRouter()
    await router.navigate('/settings')

    const navigation = router.navigate('/projects/slow')
    await vi.waitFor(() => {
      expect(pendingLoaders).toHaveLength(1)
    })

    expect(window.location.pathname).toBe('/settings')
    expect(getRouteName()).toBe('/settings')
    pendingLoaders.shift()?.()
    await navigation
    expect(getRouteName()).toBe('/projects/:id')
  })

  it('reports the destination of a back navigation while its loader runs', async () => {
    const { getRouteName, router } = createTestRouter()
    const slow = router.navigate('/projects/slow')
    await vi.waitFor(() => {
      expect(pendingLoaders).toHaveLength(1)
    })
    pendingLoaders.shift()?.()
    await slow
    await router.navigate('/settings')

    window.history.back()
    await vi.waitFor(() => {
      expect(pendingLoaders).toHaveLength(1)
    })

    expect(window.location.pathname).toBe('/projects/slow')
    expect(router.state.location.pathname).toBe('/settings')
    expect(getRouteName()).toBe('/projects/:id')
  })

  it('reports the redirect target', async () => {
    const { getRouteName, router } = createTestRouter()

    await router.navigate('/legacy/9')

    expect(window.location.pathname).toBe('/projects/9')
    expect(getRouteName()).toBe('/projects/:id')
  })

  it('reports routes declared as <Route> elements', () => {
    const routes = createRoutesFromElements(
      createElement(Route, { path: '/' }, createElement(Route, { path: 'projects/:id' }), createElement(Route, { path: 'settings' }))
    )
    const getRouteName = reactRouterRouteName({ matchRoutes, routes })

    window.history.pushState(null, '', '/projects/7')
    expect(getRouteName()).toBe('/projects/:id')
    window.history.pushState(null, '', '/settings')
    expect(getRouteName()).toBe('/settings')
  })

  it('matches each path once', () => {
    const routes = createRoutes()
    const matched: string[] = []
    const getRouteName = reactRouterRouteName({
      matchRoutes: (candidates: RouteObject[], pathname: string) => {
        matched.push(pathname)
        return matchRoutes(candidates, pathname)
      },
      routes,
    })

    getRouteName()
    getRouteName()
    window.history.pushState(null, '', '/projects/1')
    getRouteName()
    getRouteName()

    expect(matched).toEqual(['/', '/projects/1'])
  })

  it('labels SDK spans with the route of their page', async () => {
    const exporter = new InMemorySpanExporter()
    const { getRouteName, router } = createTestRouter()
    const cleanup = configure({
      rum: { session: { getRouteName } },
      spanProcessors: [new SimpleSpanProcessor(exporter)],
      traceUrl: '/client-traces',
    })

    try {
      const slow = router.navigate('/projects/slow')
      await vi.waitFor(() => {
        expect(pendingLoaders).toHaveLength(1)
      })
      startSpan('pushed navigation loading').end()
      pendingLoaders.shift()?.()
      await slow
      await router.navigate('/settings')
      startSpan('settings').end()
      window.history.back()
      await vi.waitFor(() => {
        expect(pendingLoaders).toHaveLength(1)
      })
      startSpan('back navigation loading').end()

      const pages = Object.fromEntries(
        exporter
          .getFinishedSpans()
          .map((span) => [span.name, [span.attributes['logfire.page.url.path'], span.attributes['logfire.page.route']]])
      )
      expect(pages).toEqual({
        'back navigation loading': ['/projects/slow', '/projects/:id'],
        'pushed navigation loading': ['/', '/'],
        settings: ['/settings', '/settings'],
      })
    } finally {
      await cleanup()
    }
  })
})
