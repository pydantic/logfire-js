# Vue Router example

This example groups Vue Router pages by route in Logfire browser RUM with
`vueRouterRouteName` from `@pydantic/logfire-browser/vue-router`. Its
components use render functions, so it needs no Vue compiler plugin.

## Run it

Build the workspace packages from the repository root:

```bash
pnpm run build
```

Copy the base URL and token from the frontend application page in Logfire into
a local environment file. Without them, the app runs but sends no telemetry.

```bash
cd examples/vue-router
cp .env.example .env
pnpm run dev
```

Open http://127.0.0.1:4188/ and click through the pages.

## What it shows

- `src/main.ts` passes `vueRouterRouteName(router)` to
  `rum.session.getRouteName`, so every span gets the route template in
  `logfire.page.route`. `/projects/1` and `/projects/2` both report
  `/projects/:projectId`.
- Each page logs a `page viewed` span. The line under the navigation shows the
  route name that the SDK records.
- Project pages load their data slowly. Go to Settings and back to a project:
  spans that start while its guard runs, such as the data fetch, report the
  project route. When you click a link instead, Vue Router changes the URL
  after its guards finish, so those spans belong to the page you are leaving.
- The catch-all route reports its own path, `/:pathMatch(.*)*`, for unknown
  URLs such as **Missing page**.

`packages/logfire-session-replay/browser-tests/router-examples.pw.ts` runs this
example in CI and checks that every exported span has the route of its own
URL.
