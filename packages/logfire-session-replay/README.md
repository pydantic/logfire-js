# @pydantic/logfire-session-replay

Browser session replay recorder for Logfire.

This package is experimental while Logfire Platform replay ingest and playback
are still behind a feature flag. Keep browser replay rollout behind your own
application flag and expect minor API, ingest, and UI behavior changes before
general availability.

This package records rrweb events, batches them into Logfire replay chunks, and
uploads gzip-compressed JSON envelopes to a replay upload endpoint. It is
standalone on purpose: `rrweb` and `fflate` are not dependencies of the core
`logfire` API package or `@pydantic/logfire-browser`.

## Usage

Prefer a backend replay proxy for browser applications. The SDK posts to:

```text
{replayUrl}/{sessionId}?seq={seq}
```

Example:

```ts
import { startSessionReplay } from '@pydantic/logfire-session-replay'

const replay = startSessionReplay({
  replayUrl: '/logfire/replay',
  headers: () => ({
    'X-CSRF-Token': getCsrfToken(),
  }),

  sessionSampleRate: 0.1,
  onErrorSampleRate: 1,

  maskAllInputs: true,
  blockSelector: '[data-logfire-block]',
  maskTextSelector: '[data-logfire-mask]',

  distinctId: currentUser?.id,
  getTraceContext: () => getCurrentTraceContext(),
})

await replay.flush()
await replay.stop()
```

Your proxy should forward the compressed request body and these headers to
Logfire replay ingest:

- `Content-Type: application/json`
- `Content-Encoding: gzip`

The decompressed body shape is:

```ts
{
  version: 1,
  meta: {
    seq,
    firstTimestamp,
    lastTimestamp,
    eventCount,
    clickCount,
    keypressCount,
    errorCount,
    hasFullSnapshot,
    urls,
    traceIds,
    distinctId,
  },
  events,
}
```

## Direct Token Escape Hatch

For trusted runtimes or explicitly accepted advanced browser usage, you can
send directly to Logfire ingest with a write token:

```ts
startSessionReplay({
  replayUrl: 'https://logfire-us.pydantic.dev/v1/replay',
  token: '<project-write-token>',
})
```

Normal browser applications should not expose project write tokens in bundles.
Use `replayUrl + headers` with a backend proxy when possible.

## Privacy

The recorder masks input values by default, disables canvas recording, disables
font collection, throttles media sampling, and never captures request or response
bodies. Replay can still capture DOM text, full URLs, console output, fetch/XHR
metadata, and navigation events depending on configuration.

Use `blockSelector` to omit entire DOM subtrees, `maskTextSelector` to mask text
content before events are recorded, `redactUrlPatterns` to strip query strings
and fragments from matching network URLs, and `captureConsole`,
`captureNetwork`, or `captureNavigation` to disable capture classes that are not
appropriate for your application.

## Sampling

The recorder uses a Sentry-style two-rate model:

- `sessionSampleRate`: records the full session continuously
- `onErrorSampleRate`: for sessions not selected by `sessionSampleRate`, keeps
  an in-memory replay buffer and uploads it only if an error occurs

`stop()` is awaitable and flushes the final chunk before resolving.

## Correlation

Use `getSessionId` to share a session id with another SDK layer. The
`@pydantic/logfire-browser` integration passes its browser RUM session id through
this hook when top-level `sessionReplay` is configured.

Use `getTraceContext` to stamp active trace ids into the replay stream so the
replay can be linked to browser traces and errors.

## Browser SDK Integration

Most browser applications should enable replay through
`@pydantic/logfire-browser` instead of calling `startSessionReplay()` directly:

```ts
import * as logfire from '@pydantic/logfire-browser'

logfire.configure({
  traceUrl: '/logfire-proxy/v1/traces',
  serviceName: 'browser-app',
  sessionReplay: {
    load: () => import('@pydantic/logfire-session-replay'),
    replayUrl: '/logfire-proxy/v1/replay',
  },
})
```

The browser package owns RUM session identity, span correlation attributes, and
cleanup ordering. Call `startSessionReplay()` directly only for standalone or
advanced integrations that do not use `@pydantic/logfire-browser`.

## Local Development Notes

Browser privacy extensions or ad blockers may block requests or dynamic imports
whose URLs contain terms such as `session-replay`. If replay fails to start with
`ERR_BLOCKED_BY_CLIENT`, test in a clean profile or disable the extension for
the local app.

When a Vite workspace example imports unpublished package output directly from
`dist`, make sure rrweb resolves to its browser ESM build
(`rrweb/dist/rrweb.js`). Resolving rrweb to `rrweb.cjs` can fail at runtime
because that build does not provide the named `record` export used by this
package.
