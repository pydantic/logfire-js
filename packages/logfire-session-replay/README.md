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

  // These are the privacy-safe defaults; they are shown for emphasis.
  maskAllText: true,
  maskAllInputs: true,
  blockSelector: '[data-logfire-block]',

  distinctId: currentUser?.id,
  getTraceContext: () => getCurrentTraceContext(),
})

await replay.flush()
await replay.stop()
```

### OpenTelemetry fetch and XHR instrumentation

When standalone replay runs alongside OpenTelemetry browser HTTP
instrumentation, configure ignores in both directions. Replay's
`ignoreUrlPatterns` must include the trace, metric, and replay upload endpoints
so those requests are not recorded as replay events. OpenTelemetry fetch and
XHR `ignoreUrls` must include the replay upload URL so replay uploads do not
create HTTP spans.

```ts
const telemetryUrls = [/\/client-traces(?:[?#]|$)/, /\/client-metrics(?:[?#]|$)/]
const replayUploads = [/\/client-replay\/[^/?#]+(?:\?|$)/]

getWebAutoInstrumentations({
  '@opentelemetry/instrumentation-fetch': {
    ignoreUrls: replayUploads,
  },
  '@opentelemetry/instrumentation-xml-http-request': {
    ignoreUrls: replayUploads,
  },
})

startSessionReplay({
  replayUrl: '/client-replay',
  ignoreUrlPatterns: [...telemetryUrls, ...replayUploads],
})
```

The replay fetch wrapper preserves OpenTelemetry's `fetch.__original` exporter
escape hatch when OpenTelemetry is installed first. That protects direct
exporter bypass, but it cannot infer your independently configured endpoints;
the bidirectional ignore lists are still required in either startup order.

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

## Lifecycle Delivery

Full-mode replay requests best-effort keepalive uploads when the page becomes
hidden or receives `pagehide`. Lifecycle chunks start independently of an
ordinary upload that is still in flight. The transport admits the earliest
contiguous prefix whose compressed bodies fit its 48,000-byte aggregate budget
across its own unfinished keepalive requests. Remaining lifecycle chunks are
attempted once as normal requests.

That budget is deliberately below the browser limit, but the browser quota is
shared with other unfinished keepalive requests on the page. It cannot guarantee
delivery after page freeze or termination. One individually oversized replay
event also cannot be split safely.

`headers` and functional `token` values are resolved during each upload. An
asynchronous credential callback can therefore delay the final request beyond
the browser's page-freeze boundary. Prefer synchronously available proxy
credentials, and call `flush()` before a controlled navigation when delivery is
critical.

Ordinary uploads use asynchronous gzip when available. If a restrictive Content
Security Policy blocks fflate's worker compressor, replay retries the same batch
with synchronous gzip and remembers the fallback for that replay controller.
This preserves the batch, but compression may briefly use the main thread.

## Privacy

The recorder masks all rendered text and input values by default
(`maskAllText: true`, `maskAllInputs: true`). It also disables canvas recording
and font collection, throttles media sampling, never captures request or
response bodies, and leaves console capture off (`captureConsole: false`).
Network and navigation capture remain on, but query strings and fragments are
removed from rrweb page metadata and captured network/navigation URLs by the
default `redactUrlPatterns` value. Replay envelope `meta.urls` contains those
same sanitized captured URLs.

Use `blockSelector` to omit entire DOM subtrees. Set `maskAllText: false` only
when visible text recording is acceptable; `maskTextSelector` can then retain
selective text masking. Set `captureConsole: true` only after auditing console
arguments. An explicit `redactUrlPatterns: []` restores raw captured page,
network, and navigation URLs. `captureNetwork` and `captureNavigation` can
disable those capture classes completely.

Text masking does not scrub DOM attributes, CSS content, resource URLs, or
arbitrary custom-event payloads. Avoid placing secrets there, block affected
subtrees, and sanitize custom events before recording them.

## Sampling

The recorder uses a Sentry-style two-rate model:

- `sessionSampleRate`: records the current browser session continuously
- `onErrorSampleRate`: for sessions not selected by `sessionSampleRate`, keeps
  an in-memory replay buffer and promotes it only for an uncaught `window.error`
  or `unhandledrejection`

Buffer mode is bounded by `maxBufferBytes`, measured as the UTF-8 byte sum of
event JSON before envelope metadata and compression. It keeps the latest full
snapshot and the earliest contiguous incremental events that fit; later
incrementals are dropped until rrweb emits another full snapshot. Incrementals
before an anchor or larger than the cap are dropped. If one full snapshot is
larger than the cap, that snapshot is retained alone so promoted replay remains
playable.

Sampling is resolved and persisted independently for each session id. When the
session id rotates, the returned handle updates its `mode` and `recording`
properties. A sampled-off session keeps only a lightweight session-id monitor;
it does not start rrweb or patch console, network, or navigation globals, and a
later sampled session can begin recording without reloading the page.

Caught exceptions, `console.error`, and errors reported through another API do
not automatically promote the replay buffer.

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
