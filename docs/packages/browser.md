---
title: Browser SDK
description: Set up browser error capture, request tracing, Web Vitals, and optional session replay with Logfire.
---

# Browser SDK

<span id="overview"></span>

Use `@pydantic/logfire-browser` to send browser errors, request traces, and
performance measurements to Logfire. Session replay is an optional integration.

## Install

```bash
npm install @pydantic/logfire-browser
```

## Configure

Create a frontend application in your project's settings. Copy its generated
base URL and token into your browser setup:

```ts
import * as logfire from '@pydantic/logfire-browser'

const frontendOptions = {
  // Copy these values from the frontend application page.
  baseUrl: 'https://logfire-us.pydantic.dev',
  token: '<frontend-application-token>',
}

logfire.configureFrontend(frontendOptions)
```

The restricted frontend application token can send data only for that application.
It cannot read project data or report as another service. Never put a normal
Logfire write token in browser code. A backend proxy is not required for this setup.

Call `configureFrontend()` once, before the application registers event listeners
or makes requests. The package is ESM for modern browsers. For SSR or SSG applications,
run it only in browser runtime code.
See the [Next.js guide](../frameworks/nextjs.md) for client-side initialization.

### Choose what to collect

The default setup enables automatic request and interaction tracing, uncaught
error and unhandled rejection capture, and Web Vitals spans and metrics.
Replay remains off until you add the optional integration.

For **errors and replay without performance data**, use
[`profile: 'errors'`](browser/errors.md#errors-and-replay-profile).
It keeps failed traces with their surrounding context and uploads replays when
an error occurs. Install the replay package and use the complete example in
that guide.

For **performance data**, keep the default profile. Use
[Browser performance](browser/performance.md) to adjust Web Vitals, resource timing,
or main-thread diagnostics.

If your app uses a router, [set a route name](browser/identity.md#route-names)
so pages such as `/projects/123` and `/projects/456` share a page group.

### Review captured data

Standard request URL attributes exclude credentials, query strings, and fragments
by default. [Page URL attributes](browser/identity.md#browser-sessions) and
[replay capture](browser/replay.md#privacy-controls) have their own controls.
Review those settings and any attributes your application adds before sending
sensitive data. Replay text masking does not redact every part of the document.

## Verify browser data

Reload the instrumented page and interact with it. In Logfire, select the frontend
application and a time range that includes the page load. The
[Frontend guide](https://pydantic.dev/docs/logfire/observe/frontend/) shows where
to find page loads, requests, errors, and Web Vitals.

If you chose the errors profile, [trigger a test error](browser/errors.md#verify-the-setup).
Healthy requests and clicks are intentionally absent from that profile's exports.

If data is missing, check the browser's network panel for authentication, CSP,
or content-blocker failures. Confirm that configuration runs in the browser
and uses the selected frontend application's token.

While troubleshooting locally, add `diagLogLevel` to the original configuration
call. Do not configure the SDK a second time while it is active:

```ts
logfire.configureFrontend({
  ...frontendOptions,
  diagLogLevel: logfire.DiagLogLevel.ALL,
})
```

Only enable verbose diagnostic logging in development.

## Browser guides

<span id="errors"></span>
<span id="errors-and-replay-profile"></span>
<span id="verify-the-setup"></span>
<span id="manual-client-events"></span>
<span id="minimum-level-filtering"></span>

[Errors and data volume](browser/errors.md) — Capture errors, record error-triggered replays, and choose sampling or manual log levels.

<span id="rum-session-identity"></span>
<span id="route-names"></span>
<span id="react-router"></span>
<span id="tanstack-router"></span>
<span id="vue-router"></span>
<span id="nextjs-pages-router"></span>
<span id="nextjs-app-router"></span>
<span id="sveltekit"></span>

[Routes, users, and sessions](browser/identity.md) — Set route templates, identify users, and add session context.

<span id="resource-timing-detail"></span>
<span id="rum-web-vitals"></span>
<span id="rum-long-animation-frames"></span>

[Browser performance](browser/performance.md) — Configure Web Vitals, resource timing detail, and Long Animation Frame reporting.

<span id="session-replay"></span>

[Session replay](browser/replay.md) — Record sessions, review privacy controls, and understand recording lifetime and upload limits.

<span id="custom-span-processors"></span>
<span id="baggage-span-attributes"></span>
<span id="optional-backend-proxy"></span>
<span id="first-party-ingest-domain"></span>
<span id="authenticated-application-proxy"></span>
<span id="runtime-lifecycle"></span>
<span id="pending-spans"></span>

[Advanced configuration](browser/advanced.md) — Customize instrumentation and transport, add processors, or manage SDK cleanup.

<span id="python-backend-proxy-telemetry-only"></span>

[Python telemetry proxy](../python-telemetry-proxy.md) — Forward traces, logs, and
metrics through an authenticated Python backend. These helpers do not forward replay.
