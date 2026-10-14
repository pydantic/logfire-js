---
title: Errors and data volume
description: Capture browser errors, record error-triggered replays, and control which telemetry is sent.
---

# Errors and data volume

Use the errors profile to keep failures and their surrounding traces without
collecting performance data. For page loads and Web Vitals, keep the
[default browser setup](../browser.md#configure).

The examples use `frontendOptions` from the [browser setup](../browser.md#configure).
Add these options to your application's existing `configureFrontend()` call.

## Errors and replay profile

Use `profile: 'errors'` when the application needs errors and the replays around
them, not performance data.

Replay requires Early Access and the optional replay package. Review its
[privacy controls](replay.md#privacy-controls) before enabling it.

```bash
npm install @pydantic/logfire-browser @pydantic/logfire-session-replay
```

```ts
import * as logfire from '@pydantic/logfire-browser'
import { sessionReplayIntegration } from '@pydantic/logfire-session-replay/integration'

logfire.configureFrontend({
  baseUrl: 'https://logfire-us.pydantic.dev',
  token: '<frontend-application-token>',
  profile: 'errors',
  sessionReplay: sessionReplayIntegration(),
})
```

For errors without replay, omit `sessionReplay`, its import, and the replay
package. The errors profile still keeps failed traces.

The profile keeps direct ingest, the restricted frontend application token, and
the default privacy settings. It changes these defaults:

- Tail sampling exports a trace only when one of its spans has an error level,
  an error status, or an HTTP 5xx response. The whole trace is kept, so the
  click and the request around a failure stay together. Healthy traces are
  dropped in the browser.
- Web Vitals spans and metrics, and document-load spans, are off. Long Animation
  Frames stay off.
- Session replay records only sessions with an error: `sessionSampleRate`
  defaults to `0` and `onErrorSampleRate` to `1`. Replay keeps a bounded buffer
  in memory and uploads it when `reportError()` or global error capture reports
  an error. A failed request alone keeps its trace but does not trigger a replay.

Options that you pass explicitly take precedence. For example,
`rum: { webVitals: true }` keeps Web Vitals, `sampling: { head: 0.5 }` adds head
sampling to the profile's tail rule, and `sessionReplay: { ...sessionReplayIntegration(), sessionSampleRate: 0.05 }`
records 5% of sessions in full.

### Verify the setup

You can check the setup in the Logfire UI. You do not need CLI access or SQL
queries.

1. Let the page finish loading, then interact with it for at least 10 seconds
   before triggering errors. This gives the lazy-loaded recorder time to start
   and satisfies the replay's default minimum recording duration.
2. Trigger a handled error, for example a button handler that calls
   `logfire.reportError('Checkout failed', new Error('verification'))`.
3. Trigger an unhandled error, for example
   `setTimeout(() => { throw new Error('verification uncaught') })`.
4. Use the application normally for a few clicks without errors.
5. In the frontend application's Live view, find the two error-level spans:
   `Checkout failed` with the click span that started it in the same trace, and
   `Uncaught error`. The healthy clicks from step 4 do not appear.
6. Once replay is active, error spans carry `logfire.session_replay.id`. Open
   that replay after its next upload. It contains both errors as error events
   and the buffered recording from before them.

A replay needs at least 10 seconds of recording before it uploads
(`minSessionDurationMs`), so keep the page open until at least 10 seconds of
recording have elapsed.

An error reported before the recorder starts can still appear in the replay,
but has no replay link on its span and no recording of the time before startup.
If later spans also lack a replay link, check for replay startup failures in
the browser console.

## Errors

`configure()` and `configureFrontend()` report uncaught errors and unhandled
promise rejections as error-level spans named `Uncaught error` and
`Unhandled promise rejection`. The application does not need its own `error` or
`unhandledrejection` listener. Resource load failures, such as a broken image,
are not reported. Pass `captureGlobalErrors: false` to turn global capture off.

Report caught errors with `reportError()`:

```ts
try {
  await saveOrder()
} catch (error) {
  logfire.reportError('Order save failed', error, { route: '/checkout' })
}
```

An error object is reported once. When the application reports an error and
then rethrows it, or reports it from its own `window` `error` listener, global
capture skips it. Global capture waits for the rest of the event dispatch before
it reports, so a listener registered after `configure()` still takes precedence.

With session replay, every `reportError()` call, including the calls that
global capture makes, adds the error to the replay and promotes an
error-buffered replay to a recorded one. The replay package's own global error
listeners are turned off, so an uncaught error appears in the replay once.
Replay loads after `configure()` returns. The SDK holds up to 10 errors reported
in the meantime and adds them when replay starts, with the time each error
occurred as `timestamp` in the error event. Such an error still promotes the
replay, but the recording starts after it.

## Manual client events

The browser package re-exports the manual Logfire API for custom spans and logs.

```ts
document.querySelector('button')?.addEventListener('click', () => {
  logfire.info('checkout button clicked')
})
```

With the errors profile, a manual event is exported only when its trace matches
the profile's tail-sampling rule.

## Minimum level filtering

Use `minLevel` to suppress low-severity manual Logfire telemetry before spans
are created:

```ts
logfire.configureFrontend({
  ...frontendOptions,
  minLevel: 'warning',
})
```

Browser configuration does not read Logfire environment variables. Pass
`minLevel` in code, or pass `minLevel: null` to clear a previous setting. The
filter applies to manual Logfire APIs. Log helpers and `reportError()` are
filtered by their level; `span()`, `startSpan()`, `startPendingSpan()`, and
`instrument()` are filtered only when the call or scoped client sets an
explicit level.

`minLevel` filters manual Logfire calls. It is not an errors-only filter for
automatic fetch, XHR, or interaction spans. Use the errors profile for that.
For other head and tail sampling rules, see [Sampling](../../sampling.md).
