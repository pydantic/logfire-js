import { describe, expect, it } from 'vite-plus/test'

import { reactRouterRouteName } from './reactRouter'
import { tanStackRouterRouteName } from './tanstackRouter'
import { vueRouterRouteName } from './vueRouter'

describe('router route name helpers during server rendering', () => {
  it('load and report no route without a browser location', () => {
    expect(typeof location).toBe('undefined')
    expect(reactRouterRouteName({ matchRoutes: () => [], routes: [] })()).toBeUndefined()
    expect(tanStackRouterRouteName(() => undefined)()).toBeUndefined()
    expect(vueRouterRouteName(() => undefined)()).toBeUndefined()
  })
})
