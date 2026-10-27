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

## Interaction frustration signals

Enable repeated-click detection explicitly. Experimental response detection is separately opt-in:

```ts
import { configureFrontend } from '@pydantic/logfire-browser'

configureFrontend({
  // Copy these values from the frontend application page.
  baseUrl: 'https://logfire-us.pydantic.dev',
  token: '<frontend-application-token>',
  rum: {
    frustration: {
      rageClicks: true,
      deadClicks: true,
      ignoreSelectors: ['.quantity-stepper'],
    },
  },
})
```

`rum.frustration: true` enables rage-click detection only. Replay recording is not required.
Setting both `rageClicks` and `deadClicks` to `false` disables the feature without requiring session tracking.
Events use the existing trace exporter and sampling configuration; an errors-only profile can drop
these non-error events. No event is marked as an application error merely to retain it.

- `browser.rage_click`: three clicks on the same interactive DOM element, less than one second
  apart and within 30 CSS pixels of the first click. One event is emitted per episode.
- `browser.slow_click`: an observable response arrives after 2.5 seconds but before seven seconds.
- `browser.dead_click`: no response is observed during seven seconds. This is a suspected dead
  click, not proof the action failed.

Response detection uses broad DOM mutation and interaction signals. Unrelated updates can suppress
a genuine problem; clipboard operations, CSS-only feedback and canvas rendering may be invisible.
Pointer gestures elsewhere, keyboard input, and wheel gestures discard ambiguous pending responses
rather than treating their resulting focus or scroll as application feedback. Pointer repeats on the
same pending control retain its original response deadline. Repeated-click history is retained.

The detector ignores synthetic/modifier clicks, text-editing surfaces, disabled controls, downloads,
new-window links and excluded elements or ancestors. Add `data-logfire-ignore-frustration` to repeat
controls such as quantity steppers. Frameworks replacing DOM nodes can split a rage-click episode.
Open shadow roots on the clicked element's event path are observed before application handlers run.
Closed shadow roots and cross-origin frame contents cannot be inspected; exclude interactive hosts
whose only visible response happens inside a closed root.

The response observer and its single deadline timer run only while candidates are pending; neither
polls an idle page. Navigation, backgrounding, session rollover and severely delayed deadline callbacks
discard incomplete candidates. Pending state is capped at 32 targets and 64 observed roots, and event
emission at 50 per session per SDK configuration. Reaching the root limit discards the old observation
window rather than retaining an unbounded number of trees.
Initialization failures trigger rollback; teardown failures disable further detection for that SDK configuration.

Events carry the session, user, page URL, route and replay attributes captured at click time, as other
browser spans do, even when they are reported seconds later. The detector adds no DOM
text, input values, element IDs, CSS selectors or arbitrary attributes to telemetry. Existing customer
span processors and resource attributes still apply. Use replay correlation to inspect suspected
problems before interpreting them as user frustration.
