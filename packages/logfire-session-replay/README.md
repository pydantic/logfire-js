# @pydantic/logfire-session-replay

Browser session replay recorder for Logfire.

This package supports Logfire Early Access session replay. Keep browser replay
rollout behind your own application flag and expect minor API, ingest, and UI
behavior changes before Beta.

> **Early Access pricing:** Session replay is free during Early Access. Pricing
> has not been announced and will be published before General Availability
> (GA). Session replay will become a paid feature in a later release.

This package records rrweb events, batches them into Logfire replay chunks, and
uploads gzip-compressed JSON envelopes to a replay upload endpoint. It is
standalone on purpose: `@rrweb/record` and `fflate` are not dependencies of the core
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
  getSessionAttributes: () => ({
    account_tier: currentAccount.tier,
    beta_user: currentUser.isBeta,
  }),
  getSessionId: () => getSharedBrowserSessionId(),
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
    distinctId,
    user,
    sessionAttributes,
  },
  events,
}
```

`getSessionAttributes` is snapshotted once for every replay session. Keys must
match `^[a-z][a-z0-9_]{0,63}$`; at most 20 entries are retained. Values must be
booleans, finite numbers, or strings no longer than 200 Unicode code points.
Invalid entries are omitted, and callback failures are reported through
`onError` without stopping replay. The optional `meta.sessionAttributes` field
is omitted when the snapshot is empty. Keep these dimensions low-cardinality
and free of personal or sensitive data.

`getUser` is called once for every chunk. The optional `meta.user` field keeps
only a non-empty `id`, `name`, and `email` from its result; name and email are
optional personal data, so return them only when replay viewers need them.
`meta.user` is omitted when the callback is absent, returns no user, or throws;
failures are reported through `onError`. Without `getDistinctId`, the same
snapshot's `id` is also sent as `meta.distinctId`. With `getDistinctId`, the
two values are reported independently. Receivers that do not recognize
`meta.user` can ignore it; the envelope version is unchanged.

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

Replay events use the configured `flushIntervalMs` while the user is active (5
seconds by default). After 30 seconds without recorded pointer, input, touch,
scroll, media, resize, drag, or selection activity, background events use the
greater of `flushIntervalMs` and 60 seconds. New user activity restores the
configured cadence. After five minutes without activity, background events use
the greater of `flushIntervalMs` and five minutes. After the replay reaches its
minimum duration, reaching `maxBufferBytes` still flushes immediately.

Normal recording takes a full-DOM checkpoint on the first recorded incremental
event after five minutes since the previous full snapshot. Each checkpoint
starts a new upload chunk with its `Meta` and `FullSnapshot` pair. This does not
change the upload cadence. Error-buffered recording retains its two-minute
checkpoint interval. If `minSessionDurationMs` exceeds five minutes, normal
recording uses that longer checkpoint interval so replacement snapshots cannot
restart the minimum-duration gate before it completes.

Replays must contain at least `minSessionDurationMs` of recorded events (10
seconds by default) before they are uploaded. While waiting, events stay
buffered. The initial `Meta` and `FullSnapshot` anchor is retained even when it
exceeds `maxBufferBytes`; later events are kept only while the estimated buffer
remains within the limit. After an overflow, a fresh full snapshot re-anchors
the recording when the minimum is reached. Stopping the recorder before the
minimum discards the recording. Set the option to `0` when an application must
upload a shorter replay.

Sessions created only by background timeout monitoring remain held until the
next user activity. Calling `flush()`, hiding the page, or stopping the recorder
before that activity discards the held session instead of uploading an idle-only
replay.

After a replay reaches the minimum duration, full mode requests best-effort
keepalive uploads when the page becomes hidden or receives `pagehide`.
Lifecycle chunks start independently of an
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
credentials. Before a controlled navigation, call `flush()` early enough to
reach `minSessionDurationMs`, or explicitly set the minimum to `0` when delivery
of shorter replays is critical.

Ordinary uploads use asynchronous gzip when available. If a restrictive Content
Security Policy blocks fflate's worker compressor, replay retries the same batch
with synchronous gzip and remembers the fallback for that replay controller.
This preserves the batch, but compression may briefly use the main thread.

## Upload Failures

Ordinary uploads wait in an in-memory queue and are sent in sequence order.
Network errors, timeouts, `408`, `425`, `429`, and `5xx` responses are retried
with the same sequence number and the same compressed bytes. The backoff starts
at 500 ms, doubles up to 8 s, and uses jitter. Each chunk has a 30-second retry
budget that includes the time of its requests. `Retry-After` on `429` and `503`
can lengthen a wait, never shorten it, and is honored while it fits that budget.
Other `4xx` responses are not retried. The receiver must accept a repeated
`(sessionId, seq)` as the same chunk, because a retry can follow a request that
the server stored but whose response was lost.

The queue holds at most 2,000,000 bytes, or twice `maxBufferBytes` when that is
larger. It counts uncompressed events until they are compressed, and compressed
bodies afterwards. An empty queue always admits the next batch, even when that
batch is larger than the limit, because an initial full snapshot can exceed it
and must not be lost. Otherwise, a batch that does not fit is discarded without
a sequence number, and the chunks already queued are still delivered.

A lost chunk is reported to `onError` as a `ReplayUploadError`:

- `reason`: `'unconfirmed'` when retries ran out after a request reached the
  network (the server may still hold the chunk), `'rejected'` for a terminal
  HTTP status, or `'not-sent'` when no request left the browser (full queue,
  compression failure, or a failing `headers` or `token` callback).
- `seq`: the lost chunk, or `undefined` for a batch the full queue rejected.
- `droppedSeqs`: later chunks that were discarded without upload because they
  depended on the lost one.
- `status`, `sessionId`, and `cause`.

After a loss, replay discards the events that depend on the missing DOM state
and takes a fresh full snapshot, so playback resumes correctly after the gap.
Chunks that already start from a later full snapshot are kept. Replay takes at
most one of these recovery snapshots per minute.

A `4xx` rejection other than `408`, `413`, `425`, or `429`, such as a revoked
token or a usage block (`401`, `402`, `403`), would also reject every later
chunk. Replay then reports the
`ReplayUploadError`, drops the queued chunks, and stops as `stop()` does: the
recorder detaches and no further snapshots or uploads are made in this page.

`stop()` gives each unsent chunk one last attempt and resolves within about 10
seconds, even when uploads hang. The queue lives in memory only: chunks that are
still queued when the page closes or reloads are lost, and a reloaded page does
not retry them.

## Privacy

The recorder masks all rendered text and input values by default
(`maskAllText: true`, `maskAllInputs: true`). `maskAllInputs` also masks
hidden input values. `maskAllText` also masks the text-bearing attributes
`title`, `alt`, `aria-label`, `aria-description`, `aria-placeholder`,
`aria-roledescription`, `aria-valuetext`, `label`, `placeholder`, the value of
`button`, `submit`, and `reset` inputs, and `data-*` attributes. So that styled
states and themes replay correctly, `data-*` values that are empty, `true`, or
`false` are kept, as are the attributes `data-state`, `data-orientation`,
`data-side`, `data-align`, `data-placement`, `data-popper-placement`,
`data-disabled`, `data-highlighted`, `data-selected`, `data-checked`,
`data-active`, `data-headlessui-state`, `data-slot`, `data-variant`,
`data-size`, `data-theme`, and `data-bs-theme`. The recorder also disables canvas recording
and font collection, skips inlined images and cross-origin iframe recording,
omits nonvisual DOM metadata, throttles pointer, scroll, and media sampling,
never captures request or response bodies, and leaves console capture off
(`captureConsole: false`).
Network and navigation capture remain on, but query strings and fragments are
removed from rrweb page metadata, captured network/navigation URLs, and URL
attributes (`href`, `src`, `srcset`, `poster`, `data`, `xlink:href`, and
similar) by the default `redactUrlPatterns` value. URLs with an opaque scheme,
such as `mailto:`, `tel:`, `data:`, and `blob:`, keep only the scheme. An inline
`style` value that could reference a URL, because it contains `url`,
`image-set`, `src(`, or a backslash escape, is removed whole, so such elements
can lose background images or other styling in replays. This also applies when
only `transformUrl` is set, and not with `redactUrlPatterns: []` alone. Replay envelope `meta.urls` contains those same sanitized captured
URLs. Error messages and stacks in replay error events are limited to 1,024 and
8,192 characters.

Paths can also carry private values, such as reset tokens or email addresses.
Use `transformUrl` to rewrite them. It runs after `redactUrlPatterns` on page
metadata, navigation and network URLs, and DOM URL attributes, so it also
applies to `meta.urls`. URLs inside error messages, stacks, and console
arguments keep the built-in redaction only. When `transformUrl` throws, the
URL keeps the built-in redaction and `onError` receives the error.

```ts
startSessionReplay({
  replayUrl: '/replay',
  transformUrl: (url) => url.replace(/\/reset-password\/[^/]+/u, '/reset-password/:token'),
})
```

Use `blockSelector` to omit entire DOM subtrees. Set `maskAllText: false` only
when visible text recording is acceptable; `maskTextSelector` can then retain
selective text masking. Set `captureConsole: true` only after auditing console
arguments. An explicit `redactUrlPatterns: []` restores raw captured page,
network, and navigation URLs. `captureNetwork` and `captureNavigation` can
disable those capture classes completely.

Attribute masking applies only with `maskAllText: true`; a selective
`maskTextSelector` masks text nodes only. Masking does not scrub other DOM
attributes, stylesheet content, or arbitrary custom-event payloads. Avoid
placing secrets there, block affected subtrees, and sanitize custom events
before recording them.

## Sampling

The recorder uses a Sentry-style two-rate model:

- `sessionSampleRate`: records the current browser session continuously
- `onErrorSampleRate`: for sessions not selected by `sessionSampleRate`, keeps
  an in-memory replay buffer and promotes it for an uncaught `window.error` or
  `unhandledrejection`, or for an error passed to `captureError()`

The defaults are `sessionSampleRate: 0.1` and `onErrorSampleRate: 1`: one
session in ten is recorded in full, and every other session is buffered and
uploaded only if an error occurs. Each uploaded recording counts toward your
replay usage, so choose the full-session rate from your traffic: about `0.25`
below 10,000 sessions per day, `0.1` up to 100,000, and `0.01` above that. Use
`sessionSampleRate: 1` in development so every local session is recorded.

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

Pass a caught error to `replay.captureError(error)` to add it to the replay and
promote the buffer, as an uncaught error does. For an error that occurred
earlier, pass `{ timestamp }` in epoch milliseconds; the error event records it. An error object is added once,
even when it is also uncaught later. `console.error` does not promote the buffer.

Set `captureGlobalErrors: false` when another layer listens for uncaught errors
and forwards them through `captureError()`. The replay then installs no `error`
or `unhandledrejection` listeners.

`stop()` is awaitable and flushes the final chunk before resolving.

## Correlation

Use `getSessionId` to share a session id with another SDK layer. The
`@pydantic/logfire-browser` integration passes its browser RUM session id through
this hook when top-level `sessionReplay` is configured. Other integrations must
record the same value as `session.id` on their browser spans so Logfire
can correlate those spans with the replay over its time bounds. Replay does not
apply `sessionIdleTimeoutMs` to an external id, so return a new id once the
session goes idle.

`uploading` is `true` once a `full` recording has passed `minSessionDurationMs`
and uploads what it records. Before that, the visit can still end without a
replay, so mark spans as replayed only while `uploading` is `true`.

## Browser SDK Integration

Most browser applications should enable replay through
`@pydantic/logfire-browser` instead of calling `startSessionReplay()` directly:

```ts
import * as logfire from '@pydantic/logfire-browser'
import { sessionReplayIntegration } from '@pydantic/logfire-session-replay/integration'

logfire.configure({
  traceUrl: '/logfire-proxy/v1/traces',
  serviceName: 'browser-app',
  sessionReplay: {
    ...sessionReplayIntegration(),
    replayUrl: '/logfire-proxy/v1/replay',
  },
})
```

The browser package owns RUM session identity, span correlation attributes, and
cleanup ordering. It also reports uncaught errors as spans and passes every
`reportError()` call to `captureError()`, so a handled error that the
application reports promotes an error-buffered replay. Call `startSessionReplay()` directly only for standalone or
advanced integrations that do not use `@pydantic/logfire-browser`.

## Local Development Notes

Browser privacy extensions or ad blockers may block requests or dynamic imports
whose URLs contain terms such as `session-replay`. If replay fails to start with
`ERR_BLOCKED_BY_CLIENT`, test in a clean profile or disable the extension for
the local app.

When a Vite workspace example imports unpublished package output directly from
`dist`, make sure `@rrweb/record` resolves to its browser ESM build
(`@rrweb/record/dist/record.js`). Resolving it to `record.cjs` can fail at runtime
because that build does not provide the named `record` export used by this
package.

### Background delivery

Hidden-tab flushes share the serial upload queue and retry budget with ordinary
flushes, including `Retry-After` handling for 429 and 503 responses. A hidden
tab can be frozen or discarded without a `pagehide`, so its buffered events are
split at event boundaries into chunks whose compressed envelope fits the 48 KB
keepalive budget. Each request uses keepalive while the aggregate budget allows.
A single event that does not fit uses ordinary fetch.

On `pagehide`, the SDK gives queued, unsent chunks and buffered events immediate
best-effort attempts. Buffered events are packed at event boundaries into the
remaining keepalive budget using their compressed envelope size, with a 1 MB raw
batching ceiling. Events left once the budget is spent go in one ordinary
request. Page-close attempts do not retry, and browser termination can still
lose data.

The browser SDK exports `ReplayUploadError` outcomes as warning records with
`replay.upload.reason`, `replay.upload.status_code`, `replay.recording_id`,
`replay.chunk.seq`, and `replay.upload.dropped_seqs`. These use the configured
trace exporter and its sampling policy; delivery after page termination is not
guaranteed. `unconfirmed` means the server might have stored the chunk. The
standalone recorder reports the same structured errors through `onError`.
