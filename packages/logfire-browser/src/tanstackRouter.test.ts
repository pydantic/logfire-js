/**
 * @vitest-environment jsdom
 */
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-web'
import {
  createHashHistory,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  notFound,
  redirect,
} from '@tanstack/react-router'
import type { RouterHistory } from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { clearConfiguredBrowserSessionForTests } from './browserSession'
import { configure, startSpan } from './index'
import { tanStackRouterRouteName } from './tanstackRouter'
import type { TanStackRouterLike } from './tanstackRouter'

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

// Each browser history patches window.history, so remove them after each test.
const histories: { destroy: () => void }[] = []

function createTestRouter(basepath = '/', history?: RouterHistory) {
  let releaseLoader: (() => void) | undefined
  const root = createRootRoute({})
  const home = createRoute({ getParentRoute: () => root, path: '/' })
  const projects = createRoute({ getParentRoute: () => root, path: 'projects' })
  const projectsIndex = createRoute({ getParentRoute: () => projects, path: '/' })
  const project = createRoute({
    getParentRoute: () => projects,
    loader: async ({ params }) => {
      if (params.projectId === 'slow') {
        await new Promise<void>((resolve) => {
          releaseLoader = resolve
        })
      }
      if (params.projectId === 'missing') {
        notFound({ throw: true })
      }
    },
    path: '$projectId',
  })
  const auth = createRoute({ getParentRoute: () => root, id: '_auth' })
  const settings = createRoute({ getParentRoute: () => auth, path: 'settings' })
  const files = createRoute({ getParentRoute: () => root, path: 'files/$' })
  const docs = createRoute({ getParentRoute: () => root, path: 'docs/{-$lang}/guide' })
  const legacy = createRoute({
    beforeLoad: ({ params }) => {
      redirect({ params: { projectId: params.id }, throw: true, to: '/projects/$projectId' })
    },
    getParentRoute: () => root,
    path: 'legacy/$id',
  })
  const search = createRoute({
    getParentRoute: () => root,
    path: 'search',
    validateSearch: (input: Record<string, unknown>) => {
      if (typeof input['q'] !== 'string') {
        throw new Error('q is required')
      }
      return { q: input['q'] }
    },
  })
  const routeTree = root.addChildren([
    home,
    projects.addChildren([projectsIndex, project]),
    auth.addChildren([settings]),
    files,
    docs,
    legacy,
    search,
  ])
  const router = createRouter({ basepath, routeTree, ...(history === undefined ? {} : { history }) })
  histories.push(router.history)
  // The framework's router provider loads the router on every history change.
  router.history.subscribe(() => {
    router.load().catch(() => undefined)
  })
  return {
    loaderStarted: () => releaseLoader !== undefined,
    releaseLoader: () => releaseLoader?.(),
    router,
  }
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  for (const history of histories.splice(0).reverse()) {
    history.destroy()
  }
  clearConfiguredBrowserSessionForTests()
  sessionStorage.clear()
})

describe('tanStackRouterRouteName', () => {
  it('reports one template for every URL of a dynamic route', async () => {
    window.history.replaceState(null, '', '/projects/123')
    const { router } = createTestRouter()
    const getRouteName = tanStackRouterRouteName(router)

    expect(getRouteName()).toBe('/projects/$projectId')
    await router.load()
    await router.navigate({ href: '/projects/456' })
    expect(getRouteName()).toBe('/projects/$projectId')
  })

  it.each([
    ['/', '/'],
    ['/projects', '/projects/'],
    ['/settings', '/settings'],
    ['/files/a/b/c', '/files/$'],
    ['/docs/en/guide', '/docs/{-$lang}/guide'],
    ['/docs/guide', '/docs/{-$lang}/guide'],
    ['/search?q=logs', '/search'],
    ['/search', '/search'],
    ['/projects/missing', '/projects/$projectId'],
    ['/unknown/path', '/*'],
  ])('reports %s as %s', async (href, route) => {
    const { router } = createTestRouter()
    const getRouteName = tanStackRouterRouteName(router)
    await router.load()

    await router.navigate({ href })

    expect(getRouteName()).toBe(route)
  })

  it('matches the route tree without the basepath', async () => {
    window.history.replaceState(null, '', '/app/projects/123')
    const { router } = createTestRouter('/app')
    const getRouteName = tanStackRouterRouteName(router)

    expect(getRouteName()).toBe('/projects/$projectId')
    await router.load()
    await router.navigate({ href: '/settings' })
    expect(window.location.pathname).toBe('/app/settings')
    expect(getRouteName()).toBe('/settings')
    await router.navigate({ href: '/unknown' })
    expect(getRouteName()).toBe('/*')
  })

  it('reports the new route while the previous route is still rendered', async () => {
    const { loaderStarted, releaseLoader, router } = createTestRouter()
    const getRouteName = tanStackRouterRouteName(router)
    await router.load()
    await router.navigate({ href: '/settings' })

    const routesAtNavigationStart: (string | undefined)[] = []
    router.subscribe('onBeforeNavigate', () => {
      routesAtNavigationStart.push(getRouteName())
    })
    const navigation = router.navigate({ href: '/projects/slow' })
    await vi.waitFor(() => {
      expect(loaderStarted()).toBe(true)
    })

    expect(router.state.matches.at(-1)?.fullPath).toBe('/settings')
    expect(routesAtNavigationStart).toEqual(['/projects/$projectId'])
    expect(getRouteName()).toBe('/projects/$projectId')
    releaseLoader()
    await navigation
    expect(getRouteName()).toBe('/projects/$projectId')
  })

  it('reports the redirect target after a beforeLoad redirect', async () => {
    const { router } = createTestRouter()
    const getRouteName = tanStackRouterRouteName(router)
    await router.load()
    const routes: [string, string | undefined][] = []
    router.subscribe('onBeforeNavigate', () => {
      routes.push([router.history.location.pathname, getRouteName()])
    })

    await router.navigate({ href: '/legacy/9' })

    expect(routes).toEqual([
      ['/legacy/9', '/legacy/$id'],
      ['/projects/9', '/projects/$projectId'],
    ])
    expect(getRouteName()).toBe('/projects/$projectId')
  })

  it('follows history traversal before the router reloads', async () => {
    const { router } = createTestRouter()
    const getRouteName = tanStackRouterRouteName(router)
    await router.load()
    await router.navigate({ href: '/settings' })
    await router.navigate({ href: '/files/report.pdf' })

    router.history.back()
    await vi.waitFor(() => {
      expect(window.location.pathname).toBe('/settings')
    })

    expect(getRouteName()).toBe('/settings')
  })

  it.each([
    ['hash', () => createHashHistory()],
    ['memory', () => createMemoryHistory({ initialEntries: ['/projects/1'] })],
  ])('reports routes with %s history', async (_name, createHistory) => {
    window.history.replaceState(null, '', '/#/projects/1')
    const { router } = createTestRouter('/', createHistory())
    const getRouteName = tanStackRouterRouteName(router)

    expect(getRouteName()).toBe('/projects/$projectId')
    await router.load()
    await router.navigate({ href: '/settings' })
    expect(getRouteName()).toBe('/settings')
  })

  it('matches each path once per router', async () => {
    const { router } = createTestRouter()
    const matched: string[] = []
    const countingRouter = (): TanStackRouterLike<typeof router.history.location> => ({
      history: router.history,
      matchRoutes: (pathname, search) => {
        matched.push(pathname)
        return router.matchRoutes(pathname, search as Record<string, unknown> | undefined)
      },
      parseLocation: (location) => router.parseLocation(location),
    })
    let current = countingRouter()
    const getRouteName = tanStackRouterRouteName(() => current)
    await router.load()

    getRouteName()
    getRouteName()
    await router.navigate({ href: '/projects/1' })
    getRouteName()
    getRouteName()
    current = countingRouter()
    getRouteName()

    expect(matched).toEqual(['/', '/projects/1', '/projects/1'])
  })

  it.each(['/', '/app'])('reports the home page of a root route without an index route under basepath %s', async (basepath) => {
    const root = createRootRoute({})
    const about = createRoute({ getParentRoute: () => root, path: 'about' })
    const prefix = basepath === '/' ? '' : basepath
    const router = createRouter({
      basepath,
      history: createMemoryHistory({ initialEntries: [`${prefix}/`] }),
      routeTree: root.addChildren([about]),
    })
    const getRouteName = tanStackRouterRouteName(router)

    expect(getRouteName()).toBe('/')
    await router.navigate({ href: '/about' })
    expect(getRouteName()).toBe('/about')
    await router.navigate({ href: '/unknown' })
    expect(getRouteName()).toBe('/*')
  })

  it('reports no route until a lazily created router exists', () => {
    const app: { router?: ReturnType<typeof createTestRouter>['router'] } = {}
    const getRouteName = tanStackRouterRouteName(() => app.router)

    expect(getRouteName()).toBeUndefined()
    window.history.replaceState(null, '', '/settings')
    app.router = createTestRouter().router
    expect(getRouteName()).toBe('/settings')
  })

  it('labels SDK spans with the route of their page', async () => {
    const exporter = new InMemorySpanExporter()
    const { loaderStarted, releaseLoader, router } = createTestRouter()
    const cleanup = configure({
      rum: { session: { getRouteName: tanStackRouterRouteName(router) } },
      spanProcessors: [new SimpleSpanProcessor(exporter)],
      traceUrl: '/client-traces',
    })

    try {
      await router.load()
      await router.navigate({ href: '/projects/1' })
      startSpan('first project').end()
      await router.navigate({ href: '/projects/2' })
      startSpan('second project').end()
      await router.navigate({ href: '/settings' })
      const navigation = router.navigate({ href: '/projects/slow' })
      await vi.waitFor(() => {
        expect(loaderStarted()).toBe(true)
      })
      startSpan('pending loader').end()
      releaseLoader()
      await navigation
      await router.navigate({ href: '/unknown/42' })
      startSpan('unknown').end()

      const pages = Object.fromEntries(
        exporter
          .getFinishedSpans()
          .map((span) => [span.name, [span.attributes['logfire.page.url.path'], span.attributes['logfire.page.route']]])
      )
      expect(pages).toEqual({
        'first project': ['/projects/1', '/projects/$projectId'],
        'pending loader': ['/projects/slow', '/projects/$projectId'],
        'second project': ['/projects/2', '/projects/$projectId'],
        unknown: ['/unknown/42', '/*'],
      })
    } finally {
      await cleanup()
    }
  })
})
