interface ReactRouteMatchLike {
  route: { path?: string | undefined }
}

export interface ReactRouterRouteNameOptions<TRoute> {
  /** The route objects that the application passes to its router. */
  routes: TRoute[]
  /**
   * `matchRoutes` from `react-router`. The application passes it, so this
   * module does not depend on a React Router version.
   */
  matchRoutes: (routes: TRoute[], location: string, basename?: string) => null | readonly ReactRouteMatchLike[]
  /** The router's `basename`, when it has one. */
  basename?: string
}

// The fixed name the route name contract asks for, so not-found pages group
// together without reporting their URL.
const NOT_FOUND_ROUTE = '/*'

function routeTemplate(matches: readonly ReactRouteMatchLike[]): string {
  let template = ''
  for (const { route } of matches) {
    if (route.path === undefined || route.path === '') {
      continue
    }
    template = route.path.startsWith('/') ? route.path : `${template.replace(/\/$/u, '')}/${route.path}`
  }
  return template === '' ? '/' : template
}

/**
 * Returns a `rum.session.getRouteName` callback that reports the React Router
 * route template of the current URL, for example `/projects/:id`. A URL that
 * no route matches reports `/*`. It supports routers that keep the route in
 * the URL path, such as `createBrowserRouter` and `<BrowserRouter>`.
 */
export function reactRouterRouteName<TRoute>(options: ReactRouterRouteNameOptions<TRoute>): () => string | undefined {
  let lastPathname: string | undefined
  let lastRoute: string | undefined
  return () => {
    // Match the URL that the SDK records. A back or forward navigation changes
    // it before the router's loaders finish, while `router.state` still holds
    // the previous route.
    const pathname = typeof location === 'undefined' ? undefined : location.pathname
    if (pathname === undefined) {
      return undefined
    }
    if (pathname !== lastPathname) {
      lastPathname = pathname
      const matches = options.matchRoutes(options.routes, pathname, options.basename)
      lastRoute = matches === null ? NOT_FOUND_ROUTE : routeTemplate(matches)
    }
    return lastRoute
  }
}
