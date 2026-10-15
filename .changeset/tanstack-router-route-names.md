---
'@pydantic/logfire-browser': minor
---

Group TanStack Router pages by route without a handwritten `getRouteName`. Import `tanStackRouterRouteName` from `@pydantic/logfire-browser/tanstack-router` and pass it the router, for example `getRouteName: tanStackRouterRouteName(router)`. It reports the route template that the router matches for the current URL, such as `/projects/$projectId`, removes the router's `basepath`, and reports `/*` for a URL that no route matches. It works with the React, Solid, and Vue routers and adds no dependency. The documented recipe it replaces reported `/` for every page of an application with a `basepath`, and for unknown URLs.
