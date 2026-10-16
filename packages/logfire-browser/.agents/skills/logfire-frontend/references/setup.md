# Browser Setup

Configure in a browser entrypoint before the application renders or makes
requests. Use the application's package manager and compatible SDK versions.
For tracing/RUM, install `@pydantic/logfire-browser`; install the replay package
only when the user wants replay:

```bash
npm install @pydantic/logfire-browser
# When replay is requested:
npm install @pydantic/logfire-session-replay
```

## One browser configuration

Copy `baseUrl` and the restricted token from **Frontend → Applications**. Keep
the actual region and frontend application selected by the user. The following
browser-only module enables full RUM and replay; adjust its one configuration
using [capture profiles](./capture-profiles.md) before running it.

This example requires browser SDK 0.28.0 or later. If Frontend →
Applications is unavailable, explain the missing prerequisite and link to
[Logfire support](https://pydantic.dev/docs/logfire/get-started/help/); do not
substitute an ordinary server write token.

```ts
import * as logfire from '@pydantic/logfire-browser'
import { sessionReplayIntegration } from '@pydantic/logfire-session-replay/integration'

const frontendOptions = {
  baseUrl: '<generated-regional-base-url>',
  token: '<restricted-frontend-application-token>',
}

export const frontend = logfire.configureFrontend({
  ...frontendOptions,
  sessionReplay: sessionReplayIntegration({
    maskAllText: true,
    maskAllInputs: true,
    captureConsole: false,
    blockSelector: '[data-logfire-block]',
  }),
})
```

Omit `sessionReplay` and its import for RUM-only setup. The replay sampling rates
are deliberately omitted above: preserve an existing policy or choose one with
the user. Do not imply that every session will be recorded merely because replay
is enabled. Add `data-logfire-block` to regions that should not appear in replay;
do not replace an existing block selector and lose its protected regions.

The current SDK captures uncaught JavaScript errors and unhandled promise
rejections by default. Do not add duplicate global listeners. Framework error
boundaries and caught exceptions need explicit `logfire.reportError()` calls.
Preserve existing error reporting without reporting the same failure twice.
Review error messages and added attributes for sensitive values separately
from replay masking.

`configureFrontend()` enables automatic instrumentation and Web Vitals metrics
by default. Replay is opt-in, implies browser session identity, and shares
`session.id` with browser spans. Do not set browser `serviceName` or environment
to imitate a backend service; the frontend application pins those at ingest.

The configuration handle is immediate, but automatic instrumentation and replay
load lazily. Do not assume the first request or error has a recording just
because configuration returned. Verify that startup completes before exercising
the behavior whose coverage matters.

## React, Vite, and Next.js

- **React/Vite:** import the browser-only module from the client entrypoint before
  `createRoot()`. Module initialization is shared; React Strict Mode does not
  repeat it when checking effects.
- **Next.js:** use `instrumentation-client.ts` when the installed Next.js version
  supports it. Import the browser module there, keeping server instrumentation
  separate. For older versions, dynamically import it from a root Client
  Component's effect so it executes only in the browser. Repeated imports must
  resolve to the same module/provider, rather than configuring in every mount.
- **Other browser frameworks:** use their browser entrypoint and current router
  state. Do not call configuration during SSR, SSG, or a component render.

In Next.js, import a Client Component normally from its Server Component.
If using `next/dynamic` with `ssr: false`, put that dynamic import inside a
Client Component; Next.js rejects it directly in a Server Component.

Keep instrumentation for the application's page lifetime. Do not return the
async SDK shutdown handle from a React effect: Strict Mode cleanup would stop
the shared provider. Tests/previews that replace the setup must remove any
caller-owned error listeners, await SDK cleanup, and reset initialization guards before a new
configuration. Prefer a page reload when development HMR re-executes the setup.

See [Next.js client instrumentation](https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation-client)
and [React Strict Mode](https://react.dev/reference/react/StrictMode) for the
framework's initialization and effect behavior.

Browser instrumentation does not emit automatic pending-span placeholders. Add
`startPendingSpan()` only for a specific long operation; avoid high-volume
manual spans for each mouse movement, render, or keystroke. Enable diagnostic
logging only while troubleshooting, not in a deployed browser configuration.

## Routes and user identity

Every single-page application should set `rum.session.getRouteName`. Without it, each id in a URL makes a separate page, so `/projects/1` and `/projects/2` show as two rows in page tables, filters, and Web Vitals breakdowns.

Use `@pydantic/logfire-browser` 0.28.0 or later for the router helpers. Use the helper for the app's router and add it to the existing `configureFrontend()` call:

| Router                                                                                               | Import                                                                     | `getRouteName` value                                      |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------- |
| React Router 7 or 8 with `createBrowserRouter` or `<BrowserRouter>` (6 expected to work, not tested) | `reactRouterRouteName` from `@pydantic/logfire-browser/react-router`       | `reactRouterRouteName({ routes, matchRoutes, basename })` |
| TanStack Router (tested with React; Solid and Vue share its core, not tested)                        | `tanStackRouterRouteName` from `@pydantic/logfire-browser/tanstack-router` | `tanStackRouterRouteName(router)`                         |
| Vue Router 4 or 5                                                                                    | `vueRouterRouteName` from `@pydantic/logfire-browser/vue-router`           | `vueRouterRouteName(router)`                              |

```ts
import { reactRouterRouteName } from '@pydantic/logfire-browser/react-router'
import { createBrowserRouter, matchRoutes } from 'react-router'

const router = createBrowserRouter(routes)

logfire.configureFrontend({
  baseUrl: '<generated-regional-base-url>',
  token: '<frontend-application-token>',
  rum: { session: { getRouteName: reactRouterRouteName({ matchRoutes, routes }) } },
})
```

Pass React Router the same `routes` as the router, and its `basename` when it has one. In React Router 6, import from `react-router-dom` instead of `react-router`. The React Router helper does not support hash or memory routers. If the TanStack or Vue router is created after `configureFrontend()`, pass `() => router`. Do not write a callback that reads `router.state.matches` or `router.currentRoute`: router state keeps the previous route during back and forward navigation.

For other routers, follow the browser SDK guide's [route-name contract](https://pydantic.dev/docs/logfire/instrument/typescript/packages/browser/#route-names): return the matched route template such as `/projects/:id`, never the concrete path; return a fixed name such as `/*` for not-found routes; keep the callback synchronous; and return `undefined` until the first route resolves.

For Next.js, use the SDK guide's Pages Router or App Router recipe; there is no
Next.js-specific SDK helper. Do not guess templates by stripping URL segments.

`rum.session.getUser` may return an opaque `{ id }` for the current user. Return
`undefined` on logout. Include name/email only when requested and appropriate.
Keep `getSessionAttributes` bounded, low-cardinality, and free of personal data.
These client-asserted fields are observational context, never access control.

## Privacy and transport

Keep text/input masking on and console capture off unless broader capture is
requested. Masking does not scrub DOM attributes, CSS content, resource URLs, or
custom events. Block affected subtrees and sanitize app-owned payloads. Default
URL handling removes query strings/fragments; do not restore them accidentally
when adding custom page attributes.

The restricted frontend token is designed to be public. Preserve an existing
proxy or first-party ingest domain when present. Add a proxy only when the
application needs its authentication, origin policy, or rate limits. A proxy
must support replay separately from OTLP traces/metrics and retain gzip bytes
and their content headers. Python's telemetry forwarding helpers do not forward
replay. Keep exporters and recorder from capturing their own upload requests.

When maintaining a proxy, validate each request's `Origin` against an explicitly
configured allowed origin. Reject missing configuration, missing Origin, or a
mismatch; never derive the allowed value from the incoming request. Preserve
authentication and rate limits: origin validation alone is not authentication.

Source: [browser SDK configuration and replay integration](https://pydantic.dev/docs/logfire/instrument/typescript/packages/browser/).
