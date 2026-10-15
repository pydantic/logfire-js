---
title: Routes, users, and sessions
description: Group browser data by route, identify users, and configure session context.
---

# Routes, users, and sessions

For single-page applications, set a normalized route name so URLs containing
ids are grouped under the same page. User and session attributes add context
to spans and replay metadata.

The examples use `frontendOptions` from the [browser setup](../browser.md#configure).
Add these options to your application's existing `configureFrontend()` call.

## Browser sessions

`configureFrontend()` enables browser session identity through its default Web Vitals
capture. Customize `rum.session` to control the SDK-owned session id attached to spans:

```ts
logfire.configureFrontend({
  ...frontendOptions,
  rum: { session: true },
})
```

The session is stored in `sessionStorage`, so it is scoped to the current tab
and survives page reloads. It rotates after 30 minutes of inactivity or 2 hours
of total duration by default. Each span gets the OpenTelemetry `session.id`
semantic attribute.

Use `getRouteName` for the application's normalized route template and
`getSessionAttributes` for low-cardinality dimensions that should remain stable
for a browser session. Use `getUser` for the application's current user:

```ts
import { vueRouterRouteName } from '@pydantic/logfire-browser/vue-router'

logfire.configureFrontend({
  ...frontendOptions,
  rum: {
    session: {
      getRouteName: vueRouterRouteName(router),
      getSessionAttributes: () => ({
        account_tier: currentAccount.tier,
        beta_user: currentUser?.isBeta,
      }),
      getUser: () =>
        currentUser === undefined
          ? undefined
          : {
              id: currentUser.id,
              name: currentUser.name,
              email: currentUser.email,
            },
    },
  },
})
```

Here, `router`, `currentAccount`, and `currentUser` are application-owned state,
not objects provided by Logfire. This example uses the Vue Router helper. Use
the router helper or recipe below that matches your application. These
callbacks are synchronous; return the current value rather than starting a
request.

`getRouteName` is evaluated for each span and becomes `logfire.page.route`. See
[Route names](#route-names) for the contract and router recipes.
`getUser` is also evaluated for each span. A non-empty `id` becomes `user.id`;
non-empty `name` and `email` values become `user.name` and `user.email`.
Use an opaque application id. Name and email are opt-in PII. The SDK emits
accepted strings unchanged, does not persist them, does not add them to Web
Vitals metric labels, and does not rotate the browser session when the current
user changes or logs out. Returning `undefined` represents an anonymous user or
logout. These client-asserted values are observational context, not
authentication, authorization, billing, or audit evidence.

`getSessionAttributes` is evaluated once per browser session, persisted across
same-tab reloads, and refreshed when the session rotates. Accepted values
become span attributes prefixed with `logfire.session.` and are copied into
replay chunk metadata when replay is enabled. Keys must match
`^[a-z][a-z0-9_]{0,63}$`; at most 20 entries are retained. Values must be
booleans, finite numbers, or strings no longer than 200 Unicode code points.
Invalid entries are omitted. Treat these dimensions as low-cardinality,
non-PII data because they are stored in `sessionStorage`.

Session-enabled spans also get `logfire.page.url.full` and
`logfire.page.url.path` by default for current page context. The full value is
`location.origin + location.pathname`, while the path value is
`location.pathname`; query strings and fragments are excluded. Network spans
may independently use OpenTelemetry `url.*` attributes for their request
target. Provide a callback to customize page attributes, explicitly restore the
raw page URL, or suppress them:

```ts
logfire.configureFrontend({
  ...frontendOptions,
  rum: {
    session: {
      urlAttributes: (url) => ({ full: url.href, path: url.pathname }),
    },
  },
})

logfire.configureFrontend({
  ...frontendOptions,
  rum: {
    session: {
      urlAttributes: false,
    },
  },
})
```

Call `getBrowserSessionId()` after configuring `rum.session` when another
browser integration needs the SDK-owned session id before the first span.

## Route names

Set `getRouteName` in every single-page application. Without it, the only page
dimension is `logfire.page.url.path`, so each id in a URL makes a separate page.
`/projects/123` and `/projects/456` become two pages, and page tables, filters,
and Web Vitals breakdowns split one screen into many rows. The route gives
every view of one screen the same value, so page-level analysis can group by
screen instead of by URL.

The callback has this contract:

- Return the matched route template, such as `/projects/:id`. Never return the
  concrete path.
- Return a fixed name for catch-all and not-found routes, such as `/*`. Do not
  fall back to the URL.
- Do not put ids, slugs, or user data in the value.
- The SDK calls the callback for every new span. With Web Vitals it also calls
  it in `configure()`, and with `reportSoftNavs` one task after each URL change.
  Keep it synchronous and cheap. Read router state, or a variable that the
  application updates on navigation.
- Change the value together with the URL. A span that starts after the URL
  changes but before the value changes gets the previous route.
- Return `undefined` until the router resolves the first route. The SDK then
  omits the attribute.

Each recipe below returns one value for both `/acme/shop/agents` and
`/globex/web/agents`.

### Shared route state

Next.js and SvelteKit examples store the current route in this module.
Save it as `lib/logfire-route.ts` in Next.js or `src/lib/logfire-route.ts`
in SvelteKit, and pass its `getRouteName` to `rum.session.getRouteName`.

```ts
// lib/logfire-route.ts
let routeName: string | undefined

export function setRouteName(value: string | undefined): void {
  routeName = value
}

export function getRouteName(): string | undefined {
  return routeName
}
```

### React Router

Pass the route objects and React Router's `matchRoutes` to
`reactRouterRouteName`. It reports the route template of the current URL, for
example `/projects/:id`, and adds no dependency on a React Router version:

```ts
import { reactRouterRouteName } from '@pydantic/logfire-browser/react-router'
import { createBrowserRouter, matchRoutes } from 'react-router'

const router = createBrowserRouter(routes)

logfire.configureFrontend({
  ...frontendOptions,
  rum: {
    session: {
      getRouteName: reactRouterRouteName({ matchRoutes, routes }),
    },
  },
})
```

Pass the same `routes` as the router, and its `basename` as `basename` when it
has one. In declarative mode, build the route objects from the `<Route>`
elements with `createRoutesFromElements`. In React Router 6, import
`matchRoutes` from `react-router-dom`.

The helper matches the URL path, not `router.state.matches`. A back or forward
navigation changes the URL before its loaders finish, so a span that starts
while they run gets the new route. Other navigations change the URL after
their loaders finish, so spans that start while those loaders run belong to
the previous page, with its URL and route. Pathless layout and index routes add
nothing to the template. A splat route keeps its `*`, for example `/files/*`.
A URL that no route matches reports `/*`. The helper supports routers that
keep the route in the URL path, such as `createBrowserRouter` and
`<BrowserRouter>`. It does not support hash or memory routers, or routes that
the application adds at runtime with `patchRoutesOnNavigation`.

The helper is tested with React Router 8, and checked with 6 and 7. The
[React Router example](https://github.com/pydantic/logfire-js/tree/main/examples/react-router)
is a runnable app that uses it.

### TanStack Router

Pass the router to `tanStackRouterRouteName`. It reports the route template
that the router matches for the current URL, for example
`/projects/$projectId`. It works with the React, Solid, and Vue routers, and
adds no dependency:

```ts
import { tanStackRouterRouteName } from '@pydantic/logfire-browser/tanstack-router'
import { createRouter } from '@tanstack/react-router'

const router = createRouter({ routeTree })

logfire.configureFrontend({
  ...frontendOptions,
  rum: {
    session: {
      getRouteName: tanStackRouterRouteName(router),
    },
  },
})
```

If the application creates the router after it configures Logfire, pass a
function that returns the router, such as `tanStackRouterRouteName(() => router)`.
Until the function returns a router, the SDK omits the route.

The helper matches the current URL, not `router.state.matches`. TanStack
Router changes the URL before its loaders finish, so a span that starts while a
loader runs gets the new route. The helper removes the router's `basepath`,
applies its URL rewrites, and reports the deepest match's `fullPath`. Pathless
layout routes add nothing to the template. Index routes end with a slash, for
example `/projects/`. An unknown URL matches only the root route and reports
`/*`. TanStack Router also matches the longest known prefix of a path. If no
route matches all of `/projects/1/extra`, the helper reports
`/projects/$projectId`. A loader that revalidates cached data in the
background reports the route of the page that is current when it runs, which
can be a later page.

The helper is tested with TanStack Router 1.170. The
[TanStack Router example](https://github.com/pydantic/logfire-js/tree/main/examples/tanstack-router)
is a runnable app that uses it.

### Vue Router

Pass the router to `vueRouterRouteName`. It reports the route template of the
current URL, for example `/:org/:project/agents`, and adds no dependency:

```ts
import { vueRouterRouteName } from '@pydantic/logfire-browser/vue-router'
import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({ history: createWebHistory(), routes })

logfire.configureFrontend({
  ...frontendOptions,
  rum: {
    session: {
      getRouteName: vueRouterRouteName(router),
    },
  },
})
```

If the application creates the router after it configures Logfire, pass a
function that returns the router, such as `vueRouterRouteName(() => router)`.

The helper resolves the current history location, not `router.currentRoute`.
A back or forward navigation changes the URL before its guards finish, so a
span that starts while they run gets the new route. The history base is not
part of the template. An alias reports the path of the route that it aliases.
A URL that no route matches reports `/*`, and a catch-all route reports its own
path, for example `/:pathMatch(.*)*`. The development build of Vue Router logs
a warning when the helper resolves a URL that no route matches. A route's
`beforeEnter` guard does not run when only its params change, such as from
`/projects/1` to `/projects/2`, so load per-page data in a global
`router.beforeResolve` guard or in the component.

The helper is tested with Vue Router 5, and checked with 4. The
[Vue Router example](https://github.com/pydantic/logfire-js/tree/main/examples/vue-router)
is a runnable app that uses it.

### Next.js Pages Router

Create the [shared route state module](#shared-route-state).
`router.pathname` is the page file path, for example `/blog/[slug]`. Store it
in `pages/_app.tsx`:

```tsx
import type { AppProps } from 'next/app'
import { useRouter } from 'next/router'

import { setRouteName } from '../lib/logfire-route'

export default function App({ Component, pageProps }: AppProps) {
  setRouteName(useRouter().pathname)
  return <Component {...pageProps} />
}
```

Pass `getRouteName` from this module to `rum.session.getRouteName`.

### Next.js App Router

Create the [shared route state module](#shared-route-state).
The App Router has no public API that returns the matched route template.
Rebuild it from `usePathname()` and `useParams()` in a client component that
the root layout renders. The function replaces each parameter value with its
`[name]` segment. It starts from the end of the path, because Next.js lists the
parameters in segment order and a catch-all is always last:

```tsx
'use client'

import { useParams, usePathname } from 'next/navigation'
import { Suspense, useEffect } from 'react'

import { setRouteName } from '../lib/logfire-route'

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function routeTemplate(pathname: string, params: Record<string, string | string[] | undefined>): string {
  const segments = pathname.split('/')
  let end = segments.length - 1
  for (const [name, value] of Object.entries(params).reverse()) {
    if (value === undefined) {
      continue
    }
    if (Array.isArray(value)) {
      const start = segments.length - value.length
      segments.splice(start, value.length, `[...${name}]`)
      end = start - 1
      continue
    }
    let index = end
    while (index > 0 && decodeSegment(segments[index] ?? '') !== value) {
      index--
    }
    if (index > 0) {
      segments[index] = `[${name}]`
      end = index - 1
    }
  }
  return segments.join('/') || '/'
}

function RouteName() {
  const pathname = usePathname()
  const params = useParams()
  useEffect(() => {
    setRouteName(pathname === null || params === null ? undefined : routeTemplate(pathname, params))
  }, [pathname, params])
  return null
}

export function LogfireRouteName() {
  return (
    <Suspense fallback={null}>
      <RouteName />
    </Suspense>
  )
}
```

With `cacheComponents` enabled, `useParams()` suspends during prerendering on a
route whose parameters `generateStaticParams` does not cover. The `Suspense`
boundary keeps that from failing the build.

This is an approximation, and it has these limits:

- The template does not show route groups.
- A static segment after a parameter with the same text can take the
  parameter's place.
- An optional catch-all (`[[...slug]]`) gives two values. Next.js omits the
  parameter when it is empty, so `/shop` stays `/shop` while `/shop/a` becomes
  `/shop/[...slug]`. Map such routes to one name in the application.
- A not-found page has no parameters, so the helper returns its raw path. No
  public API tells the component that the page is not found. Set a fixed name,
  such as `/*`, from the `not-found` page instead.
- The effect runs after the new page renders, so spans that start during that
  render get the previous route.

### SvelteKit

Create the [shared route state module](#shared-route-state) at
`src/lib/logfire-route.ts`. `route.id` is the route directory, for example `/blog/[slug]`. Store it from the
root `+layout.svelte`, and pass the same `getRouteName` to
`rum.session.getRouteName`:

```svelte
<script lang="ts">
  import { afterNavigate } from '$app/navigation'

  import { setRouteName } from '$lib/logfire-route'

  afterNavigate(({ to }) => {
    if (to !== null) {
      setRouteName(to.route.id ?? '/*')
    }
  })
</script>
```

SvelteKit sets `route.id` to `null` when no route matches, so the recipe uses
`/*` for not-found pages. `afterNavigate` runs after the new page renders, so spans that start during
that render get the previous route. `$lib/logfire-route` refers to that shared module.
