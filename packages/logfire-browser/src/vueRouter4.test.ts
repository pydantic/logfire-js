/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { createRouter, createWebHashHistory, createWebHistory } from 'vue-router-4'
import type { RouterHistory } from 'vue-router-4'

import { vueRouterRouteName } from './vueRouter'

// The supported Vue Router 4 contract. vueRouter.test.ts covers the latest
// major in full.
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
  vi.restoreAllMocks()
})

describe('vueRouterRouteName with Vue Router 4', () => {
  it.each([
    ['/', '/'],
    ['/projects', '/projects'],
    ['/projects/1', '/projects/:id'],
    ['/p/7', '/projects/:id'],
    ['/settings', '/settings'],
    ['/legacy/9', '/projects/:id'],
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

  it.each([
    ['web history with a base', () => createWebHistory('/app')],
    ['hash history', () => createWebHashHistory()],
  ])('matches the route table with %s', async (_name, createHistory) => {
    const { router } = createTestRouter(createHistory())
    const getRouteName = vueRouterRouteName(router)

    await router.push('/projects/1')
    expect(getRouteName()).toBe('/projects/:id')
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

    expect(router.currentRoute.value.path).toBe('/settings')
    expect(getRouteName()).toBe('/projects/:id')
    pendingGuards.shift()?.()
  })
})
