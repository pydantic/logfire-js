# Standalone Session Replay Package

## Goal

Create a standalone `packages/logfire-session-replay` package published as
`@pydantic/logfire-session-replay`.

## Execution Status

Implemented on 2026-06-29 in this branch.

The end state is:

- The Logfire JavaScript monorepo owns a browser-only session replay package.
- The package records rrweb events, computes Logfire replay chunk metadata, and
  uploads gzip-compressed chunks to a caller-provided replay upload URL.
- The package preserves Platform's current replay chunk envelope and backend
  ingest contract unless explicitly changed.
- `rrweb` and `fflate` stay isolated from the core `logfire` API package and
  from `@pydantic/logfire-browser`.
- The package has public docs, tests, Vite+ build configuration, and a
  changeset.

This PRP deliberately does not add `@pydantic/logfire-browser` integration,
RUM config, replay links from spans, Platform frontend migration, backend
schema changes, or replay player UI changes. Those belong to PRP 024 and the
Platform migration PRP.

## Why

- Platform currently carries a vendored session replay SDK POC and tarball.
  Moving the standalone package into `logfire-js` gives Platform a supported
  SDK dependency instead of a local package.
- Session replay is browser-only, privacy-sensitive, and comparatively heavy.
  Keeping it in a separate package avoids forcing rrweb/fflate into normal
  tracing users' bundles.
- Preserving the current chunk envelope lets the SDK package land without
  coordinating backend/player changes in the same PR.
- A standalone package makes the next integration PRP smaller: browser
  `configure()` can dynamically import this package only when replay is
  configured.

## Success Criteria

- [x] `packages/logfire-session-replay` exists and is included by the existing
      workspace package glob.
- [x] Package metadata follows monorepo conventions: Vite+ build scripts,
      ESM/CJS exports, declaration output, public publish config, LICENSE copy
      hooks, and `sideEffects: false`.
- [x] `rrweb` and `fflate` are added through the workspace catalog and are
      direct dependencies only of `@pydantic/logfire-session-replay`.
- [x] Public API exposes `startSessionReplay()` and the replay wire/capture
      types needed by Platform.
- [x] Public config is proxy-first: callers provide `replayUrl` and optional
      per-request headers for backend proxy uploads, with a clearly documented
      direct Logfire token escape hatch for explicit trusted-runtime or
      advanced browser use.
- [x] The uploaded chunk body remains gzip-compressed JSON with
      `Content-Type: application/json`, `Content-Encoding: gzip`, and body
      shape `{ version: 1, meta, events }`.
- [x] Chunk metadata includes timestamps, event counts, click/keypress/error
      counts, full-snapshot presence, URLs, trace ids, and optional distinct id.
- [x] `stop()` is awaitable and flushes the final chunk before resolving.
- [x] Privacy defaults mask inputs and avoid recording canvas/fonts/media by
      default.
- [x] Sampling supports the POC's Sentry-style `full` / `buffer` / `off`
      behavior.
- [x] Tests cover pure metadata extraction, sampling, session id rotation,
      recorder options, transport upload/retry/seq behavior, side-channel
      capture, and public `startSessionReplay()` lifecycle.
- [x] README/docs explain proxy setup, privacy controls, sampling, and the fact
      that browser integration is a follow-up.

## Context

### Key Files

- `../platform/src/packages/session-replay-sdk/src/index.ts` - Platform POC
  public API and lifecycle orchestration.
- `../platform/src/packages/session-replay-sdk/src/types.ts` - current replay
  config, chunk envelope, rrweb structural types, custom tags, and defaults.
- `../platform/src/packages/session-replay-sdk/src/transport.ts` - gzip chunk
  transport, sequence persistence, retry, keepalive flushes, and endpoint
  construction.
- `../platform/src/packages/session-replay-sdk/src/recorder.ts` - rrweb
  `record()` wrapper and conservative recorder options.
- `../platform/src/packages/session-replay-sdk/src/capture.ts` - console,
  fetch, and navigation custom-event capture. The POC types mention XHR, but
  the current implementation only wraps fetch.
- `../platform/src/packages/session-replay-sdk/src/extract.ts` - chunk metadata
  derivation from rrweb/custom events.
- `../platform/src/packages/session-replay-sdk/src/session.ts` - per-tab replay
  session id, storage, idle timeout, and max duration rotation.
- `../platform/src/packages/session-replay-sdk/src/sampling.ts` - full/buffer/off
  sampling decision logic.
- `../platform/src/packages/session-replay-sdk/src/*.test.ts` - tests to port
  and adapt to this repo's Vite+/Vitest conventions.
- `../platform/src/services/logfire-backend/logfire_backend/routes/v1/replay.py`
  - backend ingest contract for `/v1/replay/{session_id}` and
    `/v1/replay/browser/{session_id}`.
- `../platform/src/services/logfire-backend/logfire_backend/tests/routes/v1/test_replay.py`
  - backend expectations for envelope version, chunk limits, idempotent `seq`,
    browser-auth mode, and stored metadata.
- `packages/logfire-browser/vite.config.ts` - Vite+ package build pattern for
  ESM/CJS, declaration copying, minification, and package defines.
- `packages/logfire-browser/package.json` - package metadata pattern for public
  browser package publishing.
- `packages/logfire-browser/src/browserSession.ts` - SDK-owned browser session
  id from PRP 020. This package should allow a future external session id
  provider so PRP 024 can reuse this id.
- `docs/session-replay-integration.md` - local handoff plan. It is currently
  untracked in this branch, but it captures useful migration context.

### External References

- https://github.com/rrweb-io/rrweb - rrweb project and recorder package.
- https://www.npmjs.com/package/rrweb - current npm metadata. As of
  2026-06-29, `latest` is `2.1.0`; use latest per clarification below.
- https://www.npmjs.com/package/fflate - compression package metadata. As of
  2026-06-29, `latest` is `0.8.3`.
- https://developer.mozilla.org/en-US/docs/Web/API/Request/keepalive - browser
  keepalive constraints relevant to final flushes.

### Gotchas

- `rrweb` event shape is effectively persisted data. This PRP intentionally
  uses latest `rrweb` rather than Platform's current locked `2.0.1`; verify
  player/backend compatibility during implementation and treat event-shape
  drift as a blocker.
- The POC package currently uses `baseUrl + token` and builds
  `/v1/replay...` internally. The public SDK should use `replayUrl + headers`
  as the main browser-safe path so applications can proxy replay uploads like
  browser trace and metric uploads, while still exposing a direct-token escape
  hatch for explicit trusted-runtime or advanced browser use.
- Backend `replay.py` says the v1 app decompresses gzip before validation, but
  the SDK still sends `Content-Encoding: gzip`.
- Backend caps decompressed chunks at 25 MB. Client defaults must stay far below
  that cap and drop exhausted failed chunks rather than retaining unbounded
  memory.
- `fetch(..., { keepalive: true })` has browser payload limits and is not a
  reliable way to upload large final chunks. Keep final chunks small and make
  this limitation explicit.
- rrweb callbacks cannot be allowed to throw into host application code.
  Capture/transport errors should go through `onError` and keep recording where
  possible.
- Privacy defaults matter. Inputs should be masked by default; canvas, fonts,
  and media should remain off unless a future explicit option enables them.
- The Platform POC docs/types say `captureNetwork` captures fetch/XHR, but the
  implementation only wraps `fetch`. Implement both fetch and XHR capture here
  with tests.
- Side-channel capture monkey-patches `console`, `fetch`, and `history`. Every
  hook needs an idempotent stop function that restores originals.
- `stop()` in the POC fires an async keepalive flush but returns `void`. For SDK
  cleanup and tests, this package should make `stop()` return `Promise<void>`
  and await the final flush.
- Existing browser session identity in `@pydantic/logfire-browser` is not part
  of this package yet. Add an optional session id provider now so PRP 024 does
  not need to fork package internals.

## Clarifications

### Session 2026-06-29

- Q: Which rrweb version should this package use? -> A: Use latest rrweb. As
  of npm metadata checked on 2026-06-29, latest is `2.1.0`.
- Q: Should network side-channel capture include XHR or fetch only? -> A:
  Capture both fetch and XHR.
- Q: Should the standalone package expose a direct Logfire token escape hatch?
  -> A: Yes. Keep proxy-first as the recommended/default integration shape,
  but support direct token upload explicitly for trusted-runtime or advanced
  browser use.

## Implementation Blueprint

### Data Models

Recommended public config:

```ts
export interface SessionReplayConfig {
  /**
   * Replay upload endpoint. For normal browser applications this should be a
   * backend proxy endpoint. With the direct-token escape hatch, this may point
   * at Logfire ingest. The SDK posts to `${replayUrl}/${sessionId}?seq=${seq}`.
   */
  replayUrl: string
  /**
   * Headers added to each replay upload. Use this for CSRF/session auth to the
   * caller's backend proxy.
   */
  headers?: () => Record<string, string> | Promise<Record<string, string>>

  /**
   * Advanced escape hatch for direct Logfire ingest. Prefer `headers` with a
   * backend proxy for normal browser applications. When provided, the SDK adds
   * `Authorization: Bearer ${token}` to replay uploads.
   */
  token?: string | (() => string | Promise<string>)

  /**
   * Optional external session id source. PRP 024 should pass the
   * `@pydantic/logfire-browser` session id here.
   */
  getSessionId?: () => string | undefined

  sessionSampleRate?: number
  onErrorSampleRate?: number

  maskAllInputs?: boolean
  maskTextSelector?: string
  blockSelector?: string

  flushIntervalMs?: number
  maxBufferBytes?: number

  sessionIdleTimeoutMs?: number
  maxSessionDurationMs?: number

  distinctId?: string
  getDistinctId?: () => string | undefined
  getTraceContext?: () => { traceId?: string; spanId?: string } | undefined

  captureConsole?: boolean
  captureNetwork?: boolean
  captureNavigation?: boolean
  redactUrlPatterns?: RegExp[]

  onError?: (error: unknown) => void
  fetchImpl?: typeof fetch
  now?: () => number
  random?: () => number
}
```

Recommended returned handle:

```ts
export interface SessionReplay {
  readonly recording: boolean
  getSessionId(): string
  flush(): Promise<void>
  stop(): Promise<void>
}
```

Recommended wire types:

```ts
export const CHUNK_ENVELOPE_VERSION = 1 as const

export interface RrwebEvent {
  type: number
  data: unknown
  timestamp: number
}

export interface ChunkMeta {
  seq: number
  firstTimestamp: number
  lastTimestamp: number
  eventCount: number
  clickCount: number
  keypressCount: number
  errorCount: number
  hasFullSnapshot: boolean
  urls: string[]
  traceIds: string[]
  distinctId?: string
}

export interface ChunkEnvelope {
  version: typeof CHUNK_ENVELOPE_VERSION
  meta: ChunkMeta
  events: RrwebEvent[]
}
```

Recommended defaults:

```ts
export const DEFAULTS = {
  sessionSampleRate: 1,
  onErrorSampleRate: 1,
  maskAllInputs: true,
  maskTextSelector: '',
  blockSelector: '',
  flushIntervalMs: 5_000,
  maxBufferBytes: 1_000_000,
  sessionIdleTimeoutMs: 30 * 60_000,
  maxSessionDurationMs: 4 * 60 * 60_000,
  distinctId: '',
  captureConsole: true,
  captureNetwork: true,
  captureNavigation: true,
} as const
```

### Tasks

```yaml
Task 1: Scaffold Package
  CREATE packages/logfire-session-replay/package.json:
    - name `@pydantic/logfire-session-replay`
    - version matching repository policy for new packages
    - ESM/CJS exports and declaration paths
    - scripts: `dev`, `build`, `lint`, `preview`, `typecheck`, `test`,
      `prepack`, `postpublish`
    - dependencies: `fflate: catalog:`, `rrweb: catalog:`
    - dev dependency: `vitest: catalog:` if tests require direct access
    - `sideEffects: false`, public publish config, repository metadata
  CREATE packages/logfire-session-replay/tsconfig.json:
    - extend `../../tsconfig.base.json`
    - include `src` and `vite.config.ts`
  CREATE packages/logfire-session-replay/vite.config.ts:
    - follow `packages/logfire-browser/vite.config.ts`
    - entry `src/index.ts`
    - ESM/CJS output with `.d.cts` declaration copy
    - never-bundle `rrweb` and `fflate` only if deliberate; otherwise allow
      bundle behavior to match package dependency policy
  CREATE packages/logfire-session-replay/src/vite-env.d.ts if required by
      Vite+ conventions.

Task 2: Add Workspace Dependencies
  MODIFY pnpm-workspace.yaml:
    - add `fflate` catalog entry, recommended `^0.8.3`
    - add `rrweb` catalog entry, recommended exact latest at implementation
      time; as of 2026-06-29 this is `2.1.0`
  UPDATE pnpm-lock.yaml:
    - run `CI=true vp install --no-frozen-lockfile`
  GOTCHA:
    - latest rrweb is accepted by clarification; verify package output remains
      compatible with Platform replay ingest/player expectations.

Task 3: Port Pure Replay Types and Utilities
  CREATE packages/logfire-session-replay/src/types.ts:
    - port `RrwebEvent`, event enums, custom tags, chunk envelope, config, and
      defaults from Platform POC
    - rename public transport config from `baseUrl + token/getAuthHeaders` to
      proxy-first `replayUrl + headers`
    - add `token` as an explicit direct-ingest escape hatch, not the primary
      browser integration path
    - add `getSessionId` hook for future browser SDK integration
  CREATE packages/logfire-session-replay/src/sampling.ts:
    - port clamp and `decideSamplingMode`
  CREATE packages/logfire-session-replay/src/extract.ts:
    - port `computeChunkMeta`
  CREATE packages/logfire-session-replay/src/uuid.ts:
    - port UUID/session id generation only if internal session manager still
      needs it
  CREATE packages/logfire-session-replay/src/session.ts:
    - port internal SessionManager for standalone use
    - support external `getSessionId` in orchestration rather than forcing
      internal ids

Task 4: Port rrweb Recorder Wrapper
  CREATE packages/logfire-session-replay/src/recorder.ts:
    - import `record` from `rrweb`
    - keep structural `RrwebRecord` type to avoid over-coupling to rrweb type
      churn
    - set conservative rrweb options:
      `maskAllInputs`, `recordCanvas: false`, `collectFonts: false`,
      throttled sampling, optional `maskTextSelector`, `blockSelector`,
      optional `checkoutEveryNms`
    - expose `stop`, `addCustomEvent`, `takeFullSnapshot`
  TEST:
    - mock rrweb and assert recorder options.

Task 5: Port and Adapt Transport
  CREATE packages/logfire-session-replay/src/transport.ts:
    - buffer rrweb events
    - persist per-session `seq` in sessionStorage when available
    - compute `ChunkEnvelope` and gzip JSON via fflate
    - POST to `${replayUrl without trailing slash}/${sessionId}?seq=${seq}`
    - merge caller headers with content headers
    - when `token` is provided, add `Authorization: Bearer ${token}`
    - use `Content-Type: application/json`
    - use `Content-Encoding: gzip`
    - retry transient 5xx/network failures, not 4xx
    - serialize flushes to preserve monotonic seq
    - implement `flush({ keepalive })`
    - implement `stop()` or `shutdown()` timer cleanup
  CHANGE FROM POC:
    - do not construct `/v1/replay` or `/v1/replay/browser` inside transport
    - caller/proxy owns the endpoint path through `replayUrl`
    - support async `headers`
    - support async/string `token` as a documented direct-ingest escape hatch
    - make final stop path awaitable.

Task 6: Port Side-Channel Capture
  CREATE packages/logfire-session-replay/src/capture.ts:
    - port console capture with truncation
    - port fetch capture, with body omission and URL redaction
    - implement XHR capture, with body omission and URL redaction
    - port navigation capture for pushState/replaceState/popstate
    - ensure every capture returns an idempotent restore function
  TEST:
    - originals are restored on stop
    - console/network payloads are bounded/redacted
    - host exceptions are rethrown where appropriate and never swallowed.

Task 7: Implement Public Lifecycle
  CREATE packages/logfire-session-replay/src/index.ts:
    - export public types/constants
    - implement `startSessionReplay(config)`
    - return no-op handle for non-browser/runtime-ineligible environments
    - resolve defaults and validate `replayUrl`
    - decide sampling mode once per session
    - start recorder, transport, trace custom-event polling, error listeners,
      pagehide/visibility flushes, and optional side-channel capture
    - support internal SessionManager by default and external `getSessionId`
      when provided
    - on session id change, flush/drop old buffer according to mode and force a
      full snapshot for the new session
    - make `flush()` and `stop()` idempotent and awaitable
  GOTCHA:
    - in buffer mode, errors should switch to full mode and flush retained
      buffer.

Task 8: Port and Adapt Tests
  CREATE packages/logfire-session-replay/src/*.test.ts:
    - port Platform POC tests for capture, extract, index, recorder, sampling,
      session, transport, and uuid
    - adapt to Vite+/Vitest 4 conventions in this repo
    - mock timers/fetch/storage deterministically
    - assert proxy URL behavior rather than baseUrl/token behavior
    - assert direct `token` escape hatch behavior adds bearer authorization
    - assert `stop()` awaits final flush
  RUN:
    - `vp run @pydantic/logfire-session-replay#test`

Task 9: Add Docs and Release Note
  CREATE packages/logfire-session-replay/README.md:
    - explain standalone status
    - show `replayUrl + headers` proxy-first usage
    - document `token` as an advanced direct-ingest escape hatch and warn not
      to expose write tokens in normal browser bundles
    - document privacy defaults and selectors
    - document sampling and on-error buffering
    - document trace/distinct id hooks
    - note browser `configure()` integration is PRP 024
  CREATE .changeset/[generated-name].md:
    - add minor changeset for `@pydantic/logfire-session-replay`

Task 10: Update Roadmap
  MODIFY docs/rum-session-replay-prp-roadmap.md:
    - add `File: plans/023-standalone-session-replay-package.md`
    - update status/scope if implementation clarifies package boundaries
```

### Integration Points

```yaml
PACKAGE:
  - packages/logfire-session-replay
    New standalone browser-only package.

WORKSPACE:
  - pnpm-workspace.yaml
    Catalog entries for rrweb and fflate.
  - pnpm-lock.yaml
    Lockfile after install.

BACKEND CONTRACT:
  - ../platform/src/services/logfire-backend/logfire_backend/routes/v1/replay.py
    Preserve envelope version 1 and chunk metadata fields.

FUTURE BROWSER INTEGRATION:
  - packages/logfire-browser/src/browserSession.ts
    Future PRP 024 should pass SDK-owned session id through `getSessionId`.
  - packages/logfire-browser/src/index.ts
    No changes in this PRP except possibly docs references.

PLATFORM MIGRATION:
  - ../platform/src/services/logfire-frontend/package.json
    Later consumes published package instead of vendored tarball.
```

## Validation

Run these from the repository root:

```bash
CI=true vp install --no-frozen-lockfile
vp run @pydantic/logfire-session-replay#test
vp run @pydantic/logfire-session-replay#typecheck
vp run @pydantic/logfire-session-replay#build
vp run @pydantic/logfire-session-replay#lint
vp check
git diff --check
```

For regression confidence against existing browser RUM work:

```bash
vp run @pydantic/logfire-browser#test
vp run @pydantic/logfire-browser#typecheck
vp run @pydantic/logfire-browser#build
```

Optional manual verification after implementation:

1. Create a tiny local browser page that calls `startSessionReplay()`.
2. Point `replayUrl` at a local proxy endpoint.
3. Confirm requests are gzip uploads to `{replayUrl}/{sessionId}?seq=N`.
4. Decompress one request body and confirm `{ version: 1, meta, events }`.
5. Confirm `maskAllInputs` hides typed input values in emitted rrweb events.

### Required Test Coverage

- [x] Non-browser environments return a no-op handle.
- [x] Missing or empty `replayUrl` throws a clear configuration error.
- [x] Sampling clamps invalid rates and selects full/buffer/off modes
      deterministically.
- [x] SessionManager reuses, rotates, and resets sessions across idle/max
      duration boundaries.
- [x] External `getSessionId` is used when provided and triggers transport
      rotation when the value changes.
- [x] `computeChunkMeta()` extracts first/last timestamps, counts, URLs, trace
      ids, distinct id, and full-snapshot presence.
- [x] Recorder passes conservative rrweb privacy/performance options.
- [x] Transport uploads gzip JSON to `{replayUrl}/{sessionId}?seq={seq}` with
      expected headers.
- [x] Transport supports direct `token` auth by adding bearer authorization.
- [x] Transport persists and resumes `seq` per session id.
- [x] Concurrent flushes are serialized and allocate monotonic sequence numbers.
- [x] 5xx/network failures retry; 4xx failures do not retry.
- [x] Buffer mode does not upload until an error triggers flush.
- [x] `stop()` removes listeners/hooks, stops rrweb, stops transport timers, and
      awaits final flush.
- [x] Console/fetch/XHR/navigation capture restores original globals on stop.
- [x] Fetch and XHR capture emit bounded/redacted network custom events without
      recording request or response bodies.
- [x] Privacy/redaction tests prove input masking and URL redaction behavior.

## Unknowns & Risks

- `rrweb@2.1.0` is the current npm latest, while Platform is locked to
  `2.0.1`. Clarification accepts latest, so implementation must verify that
  generated events remain compatible with replay ingest/player expectations.
- The package intentionally supports direct-token upload as an escape hatch,
  but docs and examples should continue to steer normal browser applications
  toward a replay proxy.
- Browser keepalive can drop larger final chunks. Tests can verify code paths,
  but only browser/manual testing will prove practical payload behavior.
- Side-channel capture is useful but broad. Capturing console/fetch/navigation
  by default matches the POC, but it increases privacy and monkey-patching
  surface area.
- Existing POC XHR behavior is ambiguous. This PRP resolves the ambiguity by
  requiring XHR capture and tests.
- This package can ship independently, but Platform cannot remove its vendored
  SDK until this package is published and Platform migration work consumes it.

**Confidence: 7/10** for one-pass implementation success after clarification.
