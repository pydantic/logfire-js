---
'@pydantic/logfire-browser': minor
---

Group React Router, TanStack Router, and Vue Router pages by route without a handwritten `getRouteName`. Each helper returns the callback for `rum.session.getRouteName` and reports the route template of the current URL, such as `/projects/:id`, or `/*` for a URL that no route matches:

- `reactRouterRouteName({ routes, matchRoutes, basename })` from `@pydantic/logfire-browser/react-router`, for `createBrowserRouter` and `<BrowserRouter>`, tested with React Router 7 and 8.
- `tanStackRouterRouteName(router)` from `@pydantic/logfire-browser/tanstack-router`, tested with TanStack's React router. It reads only the router core that the Solid and Vue routers share.
- `vueRouterRouteName(router)` from `@pydantic/logfire-browser/vue-router`, tested with Vue Router 4 and 5.

The helpers add no router dependency. They match the current URL instead of the router's rendered state, so spans that start while a back or forward navigation loads get the new route. The documented recipes they replace reported the previous route during that time, and the TanStack Router recipe reported `/` for every page of an application with a `basepath`.
