# TanStack Router example

This example groups TanStack Router pages by route in Logfire browser RUM with
`tanStackRouterRouteName` from `@pydantic/logfire-browser/tanstack-router`. It
uses code-based routes; file-based routes work the same way.

## Run it

Build the workspace packages from the repository root:

```bash
pnpm run build
```

Copy the base URL and token from the frontend application page in Logfire into
a local environment file. Without them, the app runs but sends no telemetry.

```bash
cd examples/tanstack-router
cp .env.example .env
pnpm run dev
```

Open http://127.0.0.1:4187/ and click through the pages.

## What it shows

- `src/main.tsx` passes `tanStackRouterRouteName(router)` to
  `rum.session.getRouteName`, so every span gets the route template in
  `logfire.page.route`. `/projects/1` and `/projects/2` both report
  `/projects/$projectId`.
- Each page logs a `page viewed` span. The line under the navigation shows the
  route name that the SDK records.
- Project pages load their data slowly. TanStack Router changes the URL before
  its loaders run, so spans that start while a project loads, such as its data
  fetch, report the project route.
- Settings sits under a pathless layout route, which adds nothing to the
  template. The projects index reports `/projects/`, and unknown URLs, such as
  **Missing page**, report `/*`.

`packages/logfire-session-replay/browser-tests/router-examples.pw.ts` runs this
example in CI and checks that every exported span has the route of its own
URL.
