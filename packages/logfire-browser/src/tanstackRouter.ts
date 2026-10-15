/**
 * The part of a TanStack Router instance that route naming reads. Routers from
 * `@tanstack/react-router`, `@tanstack/solid-router` and `@tanstack/vue-router`
 * all provide it, so this module does not depend on any of them.
 */
export interface TanStackRouterLike<TLocation = unknown> {
  history: { location: TLocation }
  parseLocation(location: TLocation): { pathname: string; search: unknown }
  matchRoutes(pathname: string, search?: unknown): readonly { fullPath: string; routeId: string }[]
}

// TanStack's `rootRouteId`. A URL that no route matches matches only the root,
// and so does `/` when the root route renders the home page itself.
const ROOT_ROUTE_ID = '__root__'
// The fixed name the route name contract asks for, so not-found pages group
// together without reporting their URL.
const NOT_FOUND_ROUTE = '/*'

/**
 * Returns a `rum.session.getRouteName` callback that reports the TanStack
 * Router route template of the current URL, for example `/projects/$projectId`.
 * A URL that no route matches reports `/*`. Pass a function that returns
 * the router when the router is created after the SDK is configured.
 */
export function tanStackRouterRouteName<TLocation>(
  router: (() => TanStackRouterLike<TLocation> | undefined) | TanStackRouterLike<TLocation>
): () => string | undefined {
  let lastRouter: TanStackRouterLike<TLocation> | undefined
  let lastPathname: string | undefined
  let lastRoute: string | undefined
  return () => {
    const current = typeof router === 'function' ? router() : router
    if (current === undefined) {
      return undefined
    }
    // The router changes the URL before its loaders finish, while
    // `router.state` still holds the previous route, so match the URL itself.
    // `parseLocation` removes the basepath and applies the router's rewrites.
    // The history location can lead the browser URL by one microtask after a
    // navigation, but unlike `window.location` it also covers hash and memory
    // history.
    const { pathname, search } = current.parseLocation(current.history.location)
    if (current !== lastRouter || pathname !== lastPathname) {
      lastRouter = current
      lastPathname = pathname
      const match = current.matchRoutes(pathname, search).at(-1)
      const unmatched = match === undefined || (match.routeId === ROOT_ROUTE_ID && pathname !== '/')
      lastRoute = unmatched ? NOT_FOUND_ROUTE : match.fullPath
    }
    return lastRoute
  }
}
