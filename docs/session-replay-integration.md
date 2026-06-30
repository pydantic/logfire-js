---
title: Session Replay Integration Plan
description: Handoff plan for moving the Platform session replay SDK POC into logfire-js.
---

# Session Replay Integration Plan

Status: historical implementation handoff. The current SDK-side source of truth
is the PRP sequence in `plans/023-standalone-session-replay-package.md` and
`plans/024-browser-session-replay-integration.md`.

Session replay remains experimental while Logfire Platform replay ingest and
playback are behind a Platform feature flag. Keep rollout behind an application
flag until the Platform migration removes that gate.

The current source of truth is the Platform POC on branch `claude/session-replay`.
Use this document to move the browser SDK portion into `pydantic/logfire-js`
without changing the Platform backend/player contract in the same step.

## Source of Truth in Platform

SDK package:

- `../platform/src/packages/session-replay-sdk/package.json`
- `../platform/src/packages/session-replay-sdk/src/index.ts`
- `../platform/src/packages/session-replay-sdk/src/types.ts`
- `../platform/src/packages/session-replay-sdk/src/transport.ts`
- `../platform/src/packages/session-replay-sdk/src/recorder.ts`
- `../platform/src/packages/session-replay-sdk/src/capture.ts`
- `../platform/src/packages/session-replay-sdk/src/extract.ts`
- `../platform/src/packages/session-replay-sdk/src/session.ts`
- `../platform/src/packages/session-replay-sdk/src/sampling.ts`
- `../platform/src/packages/session-replay-sdk/src/uuid.ts`
- matching `*.test.ts` files in that package

Platform integration:

- `../platform/src/services/logfire-frontend/src/packages/instrumentation/init-session-replay.ts`
- `../platform/src/services/logfire-frontend/src/packages/instrumentation/browser-session.ts`
- `../platform/src/services/logfire-frontend/src/packages/instrumentation/init-instrumentation.tsx`
- `../platform/src/services/logfire-frontend/package.json`
- `../platform/src/services/logfire-frontend/vendor/pydantic-logfire-session-replay-0.0.0.tgz`

Backend/storage contract:

- `../platform/src/services/logfire-backend/logfire_backend/routes/v1/replay.py`
- `../platform/src/packages/logfire-services/logfire_services/shared_services/session_replays.py`
- `../platform/src/packages/logfire-db/logfire_db/crud/session_replays.py`
- `../platform/src/services/logfire-backend/logfire_backend/routes/ui_api/projects/replays.py`

Design notes:

- `../platform/plans/2026-06-16-session-replay.md`
- `../platform/plans/2026-06-23-rum-and-session-replay.md`

## Decision

Create a standalone package:

```text
packages/logfire-session-replay
```

Publish it as:

```text
@pydantic/logfire-session-replay
```

Do not put rrweb into the runtime-agnostic `logfire` package. Keep replay
browser-only and explicit. `@pydantic/logfire-browser` can later provide a thin
optional wrapper, but normal browser tracing users should not automatically
install or bundle replay code.

## Target API

The Platform POC currently requires `baseUrl` and a project write `token`:

```ts
startSessionReplay({
  baseUrl: 'https://logfire-us.pydantic.dev',
  token: '<project-write-token>',
})
```

That is acceptable for the internal POC, but it should not be the public browser
API. The logfire-js browser docs already require a server-side proxy for browser
telemetry so the write token is not exposed. Session replay should follow that
same model.

Preferred public API for the standalone package:

```ts
import { startSessionReplay } from '@pydantic/logfire-session-replay'

const replay = startSessionReplay({
  replayUrl: '/logfire-proxy/v1/replay',
  headers: () => ({ 'X-CSRF-Token': getCsrfToken() }),
  sessionSampleRate: 0.1,
  onErrorSampleRate: 1,
  maskAllInputs: true,
  blockSelector: '.lf-block',
  maskTextSelector: '.lf-mask',
})
```

The proxy should forward:

```text
POST {replayUrl}/{sessionId}?seq={seq}
```

to Platform:

```text
POST /v1/replay/{sessionId}?seq={seq}
```

and add the Logfire write-token authorization header on the server.

Keep a lower-level trusted-runtime option only if needed:

```ts
authorization?: string | (() => string | Promise<string>)
```

Do not make direct browser write-token usage the primary documented path.

## Future Browser Convenience API

After the standalone package works, add an optional integration in
`@pydantic/logfire-browser`.

Suggested shape:

```ts
import * as logfire from '@pydantic/logfire-browser'

logfire.configure({
  traceUrl: '/logfire-proxy/v1/traces',
  serviceName: 'web-app',
  sessionReplay: {
    replayUrl: '/logfire-proxy/v1/replay',
    sessionSampleRate: 0.1,
    onErrorSampleRate: 1,
  },
})
```

Implementation preference:

- `@pydantic/logfire-browser` has an optional peer dependency on
  `@pydantic/logfire-session-replay`.
- Load it only when `sessionReplay` is configured, preferably by dynamic import.
- Do not depend on `rrweb` directly from `@pydantic/logfire-browser`.
- Do not add replay exports to the core `logfire` package.

Example package metadata:

```json
{
  "peerDependencies": {
    "@pydantic/logfire-session-replay": "^0.1.0"
  },
  "peerDependenciesMeta": {
    "@pydantic/logfire-session-replay": {
      "optional": true
    }
  }
}
```

## Shared Session ID and Trace Correlation

The Platform POC has replay own the browser session id, then Platform injects
that id into browser spans using `BrowserSessionSpanProcessor`.

That is only a bridge. In logfire-js, session identity should become a
browser-SDK concern because RUM and traces need a stable session id even when
replay is sampled out.

Move or recreate this concept in `@pydantic/logfire-browser`:

- generate/reuse one per-tab session id
- rotate after idle timeout and max duration, matching the POC semantics
- stamp `browser.session.id` onto every browser span at span start
- expose the current session id to the replay package

The Platform POC files to study:

- `../platform/src/packages/session-replay-sdk/src/session.ts`
- `../platform/src/services/logfire-frontend/src/packages/instrumentation/browser-session.ts`
- `../platform/src/services/logfire-frontend/src/packages/instrumentation/init-session-replay.ts`

Important: the checked-out Platform frontend currently uses a patched
`@pydantic/logfire-browser` option named `spanProcessors`. Upstream
`logfire-js/packages/logfire-browser/src/index.ts` does not expose that option
today. For the wrapper path, either:

- add a supported `spanProcessors?: SpanProcessor[]` option and include them in
  the provider configuration, or
- add a first-class browser-session processor internally when session/RUM is
  enabled.

## Package Implementation Steps

1. Create `packages/logfire-session-replay`.
2. Copy the POC source and tests from `../platform/src/packages/session-replay-sdk`.
3. Convert package scripts to logfire-js conventions:

```json
{
  "scripts": {
    "dev": "vp pack --watch",
    "build": "vp pack",
    "typecheck": "tsc",
    "test": "vp test"
  }
}
```

4. Use `vite-plus` packing, modeled on `packages/logfire-browser/vite.config.ts`.
5. Depend on:

```json
{
  "dependencies": {
    "fflate": "^0.8.2",
    "rrweb": "2.0.1"
  }
}
```

Pin rrweb exactly. The Platform POC manifest says `^2.0.0-alpha.18`, but the
lockfile resolves to `2.0.1`, and the design doc says exact pinning is the
right compatibility boundary.

6. Keep the public exports close to the POC:

```ts
export { CHUNK_ENVELOPE_VERSION, CustomTag, EventType, IncrementalSource, startSessionReplay }
export type {
  ChunkEnvelope,
  ChunkMeta,
  ConsolePayload,
  NavigationPayload,
  NetworkPayload,
  RrwebEvent,
  SamplingMode,
  SessionReplay,
  SessionReplayConfig,
}
```

7. Rename transport config from `baseUrl + token` to `replayUrl + headers`.
   Preserve the wire format and endpoint suffix.
8. Keep the POC chunk envelope unchanged:

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

9. Keep gzip upload behavior:

- body is gzip-compressed JSON
- `Content-Type: application/json`
- `Content-Encoding: gzip`
- `POST {replayUrl}/{sessionId}?seq={seq}`

10. Keep `fflate` and `rrweb` isolated inside the replay package.

## Browser Package Integration Steps

These can be a follow-up PR after the standalone package lands.

1. Add optional `sessionReplay` config to
   `packages/logfire-browser/src/index.ts`.
2. Add browser session id ownership to `@pydantic/logfire-browser`.
3. Stamp `browser.session.id` on spans even when replay is disabled or sampled
   out.
4. If `sessionReplay` is configured, dynamically import
   `@pydantic/logfire-session-replay` and start it.
5. Supply replay with:

- current browser session id or session id source
- current trace context from `@opentelemetry/api`
- default `onError` using `diag.error` or `diag.warn`

6. Include replay cleanup in the `configure()` cleanup function:

- stop replay recorder
- flush final replay chunk
- then continue existing browser provider cleanup

The POC `stop()` currently fires a keepalive flush but does not return a
promise. Consider making the public cleanup path awaitable.

## Platform Migration Steps

After publishing the logfire-js package:

1. Remove `src/packages/session-replay-sdk` from Platform.
2. Remove `src/services/logfire-frontend/vendor/pydantic-logfire-session-replay-0.0.0.tgz`.
3. Change Platform frontend dependency from:

```json
"@pydantic/logfire-session-replay": "file:./vendor/pydantic-logfire-session-replay-0.0.0.tgz"
```

to the published version.

4. Update `init-session-replay.ts` to use the new proxy-oriented API.
5. Remove the local `BrowserSessionSpanProcessor` once logfire-browser owns
   `browser.session.id`.
6. Keep Platform backend routes and persistence unchanged unless changing the
   wire contract intentionally.

## Validation

In `../logfire-js`:

```bash
pnpm install
vp run @pydantic/logfire-session-replay#test
vp run @pydantic/logfire-session-replay#typecheck
vp run @pydantic/logfire-session-replay#build
vp run @pydantic/logfire-browser#test
vp run @pydantic/logfire-browser#typecheck
```

In Platform after consuming the package:

```bash
pnpm --dir src/services/logfire-frontend install
pnpm --dir src/services/logfire-frontend typecheck
pnpm --dir src/services/logfire-frontend test -- init-session-replay
```

Also run the SDK POC tests before deleting the old source:

```bash
pnpm --dir src/packages/session-replay-sdk test
pnpm --dir src/packages/session-replay-sdk typecheck
```

## Compatibility and Risk Notes

- rrweb event shape is storage format. Keep `CHUNK_ENVELOPE_VERSION = 1` and
  bump only for incompatible event-shape changes.
- Keep rrweb pinned exactly to `2.0.1` until there is a deliberate upgrade.
- Replay is privacy-sensitive. Defaults should mask inputs and docs should
  describe block/mask selectors prominently.
- The POC says `captureNetwork` captures fetch/XHR, but the implementation only
  wraps `fetch`. Either fix XHR capture or correct the docs/types before
  publishing.
- The POC final flush uses `keepalive`. Browser keepalive has payload limits, so
  long tail chunks may still be dropped on navigation.
- The backend currently caps decompressed chunks at 25 MB. Keep client defaults
  comfortably below that.
- Do not expose Logfire write tokens in public browser bundles. Use a proxy for
  replay just like browser traces.
