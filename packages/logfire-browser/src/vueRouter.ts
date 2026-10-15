interface VueRouteRecordLike {
  path: string
  aliasOf?: { path: string } | undefined
}

/**
 * The part of a Vue Router instance that route naming reads, so this module
 * does not depend on `vue-router`.
 */
export interface VueRouterLike {
  options: { history: { location: string } }
  resolve(to: string): { matched: readonly VueRouteRecordLike[] }
}

// The fixed name the route name contract asks for, so not-found pages group
// together without reporting their URL.
const NOT_FOUND_ROUTE = '/*'

/**
 * Returns a `rum.session.getRouteName` callback that reports the Vue Router
 * route template of the current URL, for example `/projects/:id`. A URL that
 * no route matches reports `/*`. Pass a function that returns the router when
 * the router is created after the SDK is configured.
 */
export function vueRouterRouteName(router: (() => undefined | VueRouterLike) | VueRouterLike): () => string | undefined {
  let lastRouter: undefined | VueRouterLike
  let lastLocation: string | undefined
  let lastRoute: string | undefined
  return () => {
    const current = typeof router === 'function' ? router() : router
    if (current === undefined) {
      return undefined
    }
    // A back or forward navigation changes the URL before its guards finish,
    // while `currentRoute` still holds the previous route, so resolve the
    // history location. It excludes the history base.
    const location = current.options.history.location
    if (current !== lastRouter || location !== lastLocation) {
      lastRouter = current
      lastLocation = location
      const record = current.resolve(location).matched.at(-1)
      // An alias reports the route it aliases, so both URLs group together.
      lastRoute = record === undefined ? NOT_FOUND_ROUTE : (record.aliasOf?.path ?? record.path)
    }
    return lastRoute
  }
}
