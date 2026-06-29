# @pydantic/logfire-session-replay

Browser session replay recorder for Logfire.

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

The defaults are conservative:

- input values are masked by default with `maskAllInputs: true`
- canvas recording is disabled
- font collection is disabled
- media sampling is throttled
- request and response bodies are never captured

Use `blockSelector` to omit entire DOM subtrees and `maskTextSelector` to mask
text content before events are recorded.

## Sampling

The recorder uses a Sentry-style two-rate model:

- `sessionSampleRate`: records the full session continuously
- `onErrorSampleRate`: for sessions not selected by `sessionSampleRate`, keeps
  an in-memory replay buffer and uploads it only if an error occurs

`stop()` is awaitable and flushes the final chunk before resolving.

## Correlation

Use `getSessionId` to share a session id with another SDK layer. The future
`@pydantic/logfire-browser` integration will pass its browser RUM session id
through this hook.

Use `getTraceContext` to stamp active trace ids into the replay stream so the
replay can be linked to browser traces and errors.

## Browser SDK Integration

This package does not add `rum.sessionReplay` to `@pydantic/logfire-browser`.
That integration is a follow-up PRP. Until then, call `startSessionReplay()`
directly.
