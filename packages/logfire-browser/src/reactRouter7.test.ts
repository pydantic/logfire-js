/**
 * @vitest-environment jsdom
 */
import { createBrowserRouter, matchRoutes, redirect } from 'react-router-7'
import type { RouteObject } from 'react-router-7'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { reactRouterRouteName } from './reactRouter'

// The supported React Router 7 contract. reactRouter.test.ts covers the
// latest major in full.
const pendingLoaders: (() => void)[] = []
const routers: { dispose: () => void }[] = []

function createTestRouter(basename?: string) {
  const routes: RouteObject[] = [
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
        { loader: ({ params }) => redirect(`/projects/${String(params['id'])}`), path: 'legacy/:id' },
      ],
      path: '/',
    },
  ]
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
})

describe('reactRouterRouteName with React Router 7', () => {
  it.each([
    ['/', '/'],
    ['/projects', '/projects'],
    ['/projects/1', '/projects/:id'],
    ['/settings', '/settings'],
    ['/files/a/b', '/files/*'],
    ['/legacy/9', '/projects/:id'],
    ['/unknown/42', '/*'],
  ])('reports %s as %s', async (href, route) => {
    const { getRouteName, router } = createTestRouter()

    await router.navigate(href)

    expect(getRouteName()).toBe(route)
  })

  it('matches the routes without the basename', async () => {
    window.history.replaceState(null, '', '/app/projects/1')
    const { getRouteName, router } = createTestRouter('/app')

    expect(getRouteName()).toBe('/projects/:id')
    await router.navigate('/settings')
    expect(getRouteName()).toBe('/settings')
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

    expect(router.state.location.pathname).toBe('/settings')
    expect(getRouteName()).toBe('/projects/:id')
  })
})
