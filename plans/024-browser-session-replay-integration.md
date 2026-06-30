# Browser Session Replay Integration

## Goal

Add opt-in session replay integration to `@pydantic/logfire-browser` using the
standalone `@pydantic/logfire-session-replay` package from PRP 023.

The end state is:

- Browser `configure()` accepts a first-class `sessionReplay` option.
- Replay remains disabled by default and is loaded only when `sessionReplay` is
  configured.
- `@pydantic/logfire-browser` does not put `rrweb` or `fflate` in its direct
  runtime dependencies.
- The browser SDK owns the session id and passes it into replay through
  `getSessionId`, so browser spans and replay chunks share the same join key.
- Replay publishes its active recording state back to the browser SDK, and
  browser spans started while replay is active get minimal replay state
  attributes.
- The authoritative correlation model is shared `session.id` /
  `browser.session.id` plus replay/span timestamps. The browser integration does
  not enable replay trace-id polling by default.
- Browser SDK cleanup stops and flushes replay before OTel exporter shutdown.

This PRP deliberately does not publish packages, migrate Platform to consume the
new SDK APIs, change replay backend/player contracts, or add a Logfire UI replay
link. Those belong to the release and Platform migration follow-up.

Session replay should remain documented as experimental until Logfire Platform
replay ingest and playback are no longer gated by the Platform feature flag.

## Why

- PRP 023 created a supported standalone replay package, but callers still need
  to wire it manually. Platform needs a browser SDK integration to remove its
  local vendored replay package cleanly.
- Session replay should correlate with RUM spans even when Web Vitals are not
  enabled. Browser session identity is already owned by `@pydantic/logfire-browser`
  after PRP 020.
- Trace ids collected by polling active context are incomplete by construction
  and can be misread as the complete trace set for a replay. Span-side replay
  state keeps the correlation signal on OTel spans, where it is naturally scoped
  to emitted telemetry.
- Replay is privacy-sensitive and heavy. Keeping it optional preserves the
  normal browser tracing bundle for users that do not opt in.
- Cleanup ordering matters because replay and OTel browser instrumentations both
  monkey-patch browser APIs such as `fetch`. The browser SDK should own a safe,
  tested lifecycle.

## Success Criteria

- [x] `LogfireConfigOptions` exposes `sessionReplay?: false | BrowserSessionReplayOptions`.
- [x] `BrowserSessionReplayOptions` is defined locally in
      `@pydantic/logfire-browser` so the public browser package declarations do
      not require TypeScript users to install `@pydantic/logfire-session-replay`
      unless they configure replay.
- [x] `@pydantic/logfire-browser` declares
      `@pydantic/logfire-session-replay` as an optional peer dependency and as a
      local development dependency, not as a direct runtime dependency.
- [x] Replay loading uses an explicit `sessionReplay.load` callback rather than
      a static bare-specifier import in the browser package, so applications
      that do not configure replay never need their bundler to resolve the
      optional peer.
- [x] `configure()` does not load replay by default or when
      `sessionReplay: false`.
- [x] When `sessionReplay` is configured, the browser SDK starts replay after
      tracer provider registration and passes the SDK-owned browser session id
      plus all proxy/auth/privacy/sampling options from `sessionReplay`.
- [x] When replay starts in a recording mode, browser spans started afterward
      receive replay state attributes such as
      `logfire.session_replay.active = true` and
      `logfire.session_replay.mode = "full" | "buffer"`.
- [x] Replay state span attributes read the live replay mode, including the
      `buffer` to `full` transition that happens after an error-triggered
      upload.
- [x] The browser integration does not pass `getTraceContext` to the replay
      package by default. Replay `meta.traceIds` remains a standalone/legacy
      low-level behavior, not the browser SDK's canonical correlation path.
- [x] `sessionReplay` implies browser session attributes by default, matching
      the `rum.webVitals` behavior. `rum.session: false` plus `sessionReplay`
      throws a clear configuration error.
- [x] Browser SDK cleanup awaits replay startup, stops replay exactly once, and
      runs replay stop before instrumentation unregister, browser metric flush,
      trace force flush, and tracer provider shutdown.
- [x] Replay startup/import errors are surfaced through `diag.error` and
      `sessionReplay.onError`, without breaking tracing setup or causing
      unhandled promise rejections.
- [x] Existing browser tracing, RUM session, Web Vitals, and metrics behavior is
      unchanged when replay is not configured.
- [x] Browser docs and examples show the proxy-first replay setup and explain
      that direct token usage is an advanced escape hatch.
- [x] Browser docs and examples mark session replay as experimental while
      Platform replay ingest/playback are feature-flagged.
- [x] Browser replay config defaults suppress Logfire telemetry endpoint network
      events, not merely redact their URLs, so replay does not record the
      browser SDK's own trace, metrics, or replay upload traffic.
- [x] Package-visible changes include changesets for both
      `@pydantic/logfire-browser` and `@pydantic/logfire-session-replay`.
- [x] Tests cover disabled behavior, enabled behavior, session id sharing, trace
      polling being omitted, replay state span attributes,
      missing/import-failed peer handling, cleanup ordering, and cleanup
      idempotency.

## Context

### Key Files

- `packages/logfire-browser/src/index.ts` - owns `configure()`, browser provider
  setup, RUM session setup, Web Vitals startup, browser metrics startup, and the
  memoized cleanup lifecycle. This is the main integration point.
- `packages/logfire-browser/src/browserSession.ts` - owns
  `BrowserSessionManager`, `getBrowserSessionId()`, session rotation, and URL
  attribute policy. Replay should reuse this manager, not create a parallel
  browser session id.
- `packages/logfire-browser/src/index.test.ts` - configure-level tests already
  mock Web Vitals, browser metrics, tracer provider lifecycle, and cleanup
  ordering. Extend this harness for replay.
- `packages/logfire-browser/package.json` - add optional peer metadata and local
  dev dependency for `@pydantic/logfire-session-replay`.
- `packages/logfire-browser/README.md` and `docs/packages/browser.md` -
  document `sessionReplay`, proxy configuration, sampling, privacy controls,
  and cleanup.
- `examples/browser/src/main.ts`, `examples/browser/src/proxy.ts`, and
  `examples/browser/README.md` - extend the browser smoke example with optional
  replay config and proxy route if that example is still the preferred manual
  browser verification target.
- `packages/logfire-session-replay/src/index.ts` - public
  `startSessionReplay()` lifecycle and `SessionReplay` handle.
- `packages/logfire-session-replay/src/types.ts` - standalone replay config
  shape. Browser integration should mirror this shape structurally without
  exporting a hard type dependency from browser declarations.
- `packages/logfire-session-replay/README.md` - proxy-first replay usage,
  direct token escape hatch, privacy defaults, sampling, and correlation
  behavior to reference from browser docs.
- `docs/rum-session-replay-prp-roadmap.md` - umbrella roadmap. PRP 024 is the
  final SDK-side replay step before Platform migration.
- `docs/session-replay-integration.md` - untracked handoff document with
  Platform migration context. This predates PRPs 020 and 023, so treat it as
  historical context only where it conflicts with current source code.
- `../platform/src/services/logfire-frontend/src/packages/instrumentation/init-session-replay.ts`
  - Platform POC wiring that this browser integration should replace.
- `../platform/src/services/logfire-frontend/src/packages/instrumentation/init-instrumentation.tsx`
  - Platform feature-flag integration that will later call the public browser
    API.
- `../platform/src/services/logfire-backend/logfire_backend/routes/v1/replay.py`
  - existing replay ingest contract that the browser integration must preserve
    through the standalone package.

### External References

- https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/import
  - dynamic `import()` behavior for lazy loading the optional replay package.
- https://nodejs.org/api/packages.html#peer-dependencies
  - peer dependency model. The replay package should be optional for browser
    users that do not configure replay.
- https://github.com/rrweb-io/rrweb
  - rrweb recorder project. The browser package should not depend on rrweb
    directly.

### Gotchas

- Do not import public replay types into exported browser types. If
  `@pydantic/logfire-browser` declarations import
  `@pydantic/logfire-session-replay`, TypeScript users may need to install the
  optional package even when they do not use replay.
- A static dynamic import of a bare optional peer can make some bundlers resolve
  that peer even for applications that do not configure replay. Use an explicit
  `sessionReplay.load` callback so the app that enables replay owns the import
  expression and no-replay apps do not resolve the optional peer.
- Do not put `@pydantic/logfire-session-replay` in browser `dependencies`.
  That would pull rrweb/fflate into normal browser tracing installs.
- `sessionReplay` should imply `rum.session` because replay needs the browser
  SDK session id. Reject `sessionReplay` with `rum.session: false` instead of
  creating a separate replay-only session id.
- Cleanup ordering with monkey patches is subtle. If OTel fetch instrumentation
  is active and replay wraps `fetch`, stopping replay before unregistering OTel
  avoids restoring stale wrappers. Replay should also be stopped before metric
  or trace exporter flushes so telemetry export requests are not recorded into
  the replay.
- Replay `stop()` is async and performs a final upload. Cleanup must await it
  but continue best-effort cleanup if it fails.
- Do not wire `getTraceContext` by default from the browser integration. The
  replay package still supports it for standalone advanced users, but browser
  SDK correlation should not populate incomplete `traceIds` that can be
  mistaken for the complete trace set.
- Replay state attributes on spans must be semantically precise. In `buffer`
  mode the browser is recording a local error buffer, but a replay may not be
  persisted unless an error triggers upload. Do not label this as "has replay"
  without checking that a replay row/chunk actually exists.
- Replay mode is dynamic. The standalone replay transport upgrades
  `buffer -> full` after the first error-triggered upload. Span attributes must
  read the live mode instead of caching the startup mode.
- When the browser SDK supplies `getSessionId`, replay package
  `sessionIdleTimeoutMs` and `maxSessionDurationMs` no longer drive replay
  identity. Browser integration should leave session lifecycle on `rum.session`
  options and should not expose dead replay timeout knobs.
- The replay package calls `getSessionId` for every rrweb event. Do not wire this
  to `browserSessionManager.touch()` directly; that would do synchronous
  session storage work on the rrweb hot path and could keep a session alive from
  DOM churn rather than real telemetry activity.
- `BrowserSessionManager.getSession()` is also not the right hot-path accessor
  for replay. It reads/parses storage on each call and creates a new session if
  the stored one is expired. Add a zero-I/O peek method for replay instead of
  letting rrweb events drive session creation, expiry checks, or rotation.
- Replay network capture wraps `window.fetch` and XHR. Without default
  suppression, browser OTLP trace and metric exporter requests can appear as
  replay network events throughout the session, not only during shutdown.
  `redactUrlPatterns` in the standalone replay package currently only removes
  query/hash detail from the recorded URL; it does not suppress the network
  event. Do not rely on redaction alone for SDK telemetry endpoints.
- Direct token usage should remain documented as an advanced escape hatch.
  Browser docs should recommend `replayUrl + headers` through a backend proxy.
- Replay side-channel capture may record console, fetch/XHR, and navigation
  events. The browser integration must preserve the standalone package defaults
  and let callers disable these capture classes.
- Local development can fail before replay startup if a browser privacy
  extension blocks dev URLs containing `session-replay`. Examples should prefer
  a neutral import URL when loading local workspace replay output.
- When Vite examples import unpublished replay package output directly from
  `dist`, ensure rrweb resolves to its browser ESM build
  (`rrweb/dist/rrweb.js`). Resolving to `rrweb.cjs` breaks the named `record`
  import at runtime.

## Implementation Blueprint

### Data Models

Recommended local browser option shape:

```ts
export type MaybePromise<T> = T | Promise<T>

export interface BrowserSessionReplayRuntime {
  readonly recording: boolean
  readonly mode: 'full' | 'buffer' | 'off'
  getSessionId(): string
  flush(): Promise<void>
  stop(): Promise<void>
}

export interface BrowserSessionReplayModule {
  startSessionReplay(config: BrowserSessionReplayPackageConfig): BrowserSessionReplayRuntime
}

export interface BrowserSessionReplayPackageConfig {
  replayUrl: string
  headers?: () => MaybePromise<Record<string, string>>
  token?: string | (() => MaybePromise<string>)
  getSessionId?: () => string | undefined
  sessionSampleRate?: number
  onErrorSampleRate?: number
  maskAllInputs?: boolean
  maskTextSelector?: string
  blockSelector?: string
  flushIntervalMs?: number
  maxBufferBytes?: number
  distinctId?: string
  getDistinctId?: () => string | undefined
  captureConsole?: boolean
  captureNetwork?: boolean
  captureNavigation?: boolean
  redactUrlPatterns?: RegExp[]
  ignoreUrlPatterns?: RegExp[]
  onError?: (error: unknown) => void
  fetchImpl?: typeof fetch
}

export interface BrowserSessionReplayOptions {
  /**
   * Loads @pydantic/logfire-session-replay. The application owns this import so
   * no-replay applications do not need their bundler to resolve the optional
   * peer dependency.
   */
  load: () => MaybePromise<BrowserSessionReplayModule>
  /**
   * Replay upload endpoint. For browser apps this should normally be a backend
   * proxy endpoint. The replay package posts to `${replayUrl}/${sessionId}?seq=${seq}`.
   */
  replayUrl: string
  /**
   * Headers added to each replay upload. Use this for CSRF/session auth to the
   * caller's backend proxy.
   */
  headers?: () => MaybePromise<Record<string, string>>
  /**
   * Advanced escape hatch for direct Logfire ingest. Prefer `headers` with a
   * backend proxy for normal browser applications.
   */
  token?: string | (() => MaybePromise<string>)

  sessionSampleRate?: number
  onErrorSampleRate?: number

  maskAllInputs?: boolean
  maskTextSelector?: string
  blockSelector?: string

  flushIntervalMs?: number
  maxBufferBytes?: number

  distinctId?: string
  getDistinctId?: () => string | undefined

  captureConsole?: boolean
  captureNetwork?: boolean
  captureNavigation?: boolean
  redactUrlPatterns?: RegExp[]
  ignoreUrlPatterns?: RegExp[]

  onError?: (error: unknown) => void
  fetchImpl?: typeof fetch
}

export interface LogfireConfigOptions {
  sessionReplay?: false | BrowserSessionReplayOptions
}
```

Do not expose `getSessionId` or `getTraceContext` in
`BrowserSessionReplayOptions`. The browser integration owns `getSessionId` and
intentionally does not wire `getTraceContext` by default. Users that need
complete low-level control can call `@pydantic/logfire-session-replay` directly.
Do not expose `sessionIdleTimeoutMs` or `maxSessionDurationMs` here; browser
session lifecycle is controlled by `rum.session` when the browser SDK owns the
session id.

Recommended standalone replay handle extension:

```ts
export interface SessionReplay {
  readonly recording: boolean
  /**
   * Live recording mode. Buffer mode upgrades to full after the first
   * error-triggered upload.
   */
  readonly mode: 'full' | 'buffer' | 'off'
  getSessionId(): string
  flush(): Promise<void>
  stop(): Promise<void>
}
```

Recommended internal browser replay state bridge:

```ts
export type BrowserSessionReplaySpanMode = 'full' | 'buffer'

export interface BrowserSessionReplaySpanState {
  active: true
  mode: BrowserSessionReplaySpanMode
}

export class BrowserSessionReplayState {
  private replay: BrowserSessionReplayRuntime | undefined

  setReplay(replay: BrowserSessionReplayRuntime): void {
    this.replay = replay
  }

  clear(): void {
    this.replay = undefined
  }

  getState(): BrowserSessionReplaySpanState | undefined {
    const mode = this.replay?.mode
    if (this.replay?.recording !== true || (mode !== 'full' && mode !== 'buffer')) {
      return undefined
    }

    return { active: true, mode }
  }
}
```

Recommended span attributes:

- `logfire.session_replay.active = true` only while replay is actually active
  for the browser session.
- `logfire.session_replay.mode = "full" | "buffer"` to distinguish continuously
  uploaded replay from error-buffer replay.

Do not stamp a separate replay session id by default. `session.id` and
`browser.session.id` are the shared replay/span join keys.

### Tasks

```yaml
Task 1: Add Browser Replay Types And Dependency Metadata
  MODIFY packages/logfire-browser/package.json:
    - Add @pydantic/logfire-session-replay as an optional peer dependency.
    - Add peerDependenciesMeta entry marking it optional.
    - Add @pydantic/logfire-session-replay as a workspace devDependency for
      local typecheck/tests/build only.
    - Do not add it to dependencies.
    - Keep published peer range handling explicit: use workspace protocol in
      this branch and defer final semver range to the release/publish step while
      @pydantic/logfire-session-replay is still version 0.0.0.
  MODIFY packages/logfire-browser/src/index.ts or CREATE packages/logfire-browser/src/sessionReplay.ts:
    - Define and export BrowserSessionReplayOptions locally.
    - Include required load: () => import('@pydantic/logfire-session-replay') style callback.
    - Avoid exported type imports from @pydantic/logfire-session-replay.
    - Define internal BrowserSessionReplayState / BrowserSessionReplaySpanState
      helpers for span-side replay state.
    - Add a dev/test-only type assertion that local BrowserSessionReplayPackageConfig
      stays assignable to the peer package SessionReplayConfig while the peer is
      installed in the workspace.
  MODIFY packages/logfire-session-replay/src/index.ts, packages/logfire-session-replay/src/types.ts, and packages/logfire-session-replay/src/capture.ts:
    - Expose live replay sampling mode on the SessionReplay handle:
      readonly mode: 'full' | 'buffer' | 'off'.
    - Implement mode as a getter that delegates to transport.getMode(), so the
      buffer -> full transition after first error is visible.
    - Add optional network-event suppression such as ignoreUrlPatterns?: RegExp[]
      to SessionReplayConfig / ResolvedSessionReplayConfig.
    - Suppress matching fetch and XHR network events before emitting
      logfire.network custom events. Keep redaction behavior separate.
    - Keep this additive and backwards compatible.
  MODIFY pnpm-lock.yaml if dependency metadata changes require it.

Task 2: Resolve Session Requirements
  MODIFY packages/logfire-browser/src/browserSession.ts:
    - Add a BrowserSessionManager.peekSessionId(): string | undefined method.
    - The method must return only the current in-memory session id.
    - It must not read from storage, write to storage, update lastActivityAt,
      check expiry, create a new session, or rotate the session.
    - Existing lifecycle-driving APIs keep their current roles:
      touch() owns telemetry activity and session expiry/creation;
      getSession() remains a read-through session accessor that can create a
      session on expiry.
  MODIFY packages/logfire-browser/src/index.ts:
    - Extend resolveBrowserSessionOptions() to consider sessionReplay.
    - If sessionReplay is configured and rum.session is false, throw a clear
      error such as:
      "logfire-browser: sessionReplay requires browser session attributes; remove rum.session: false or disable sessionReplay".
    - If sessionReplay is configured and rum.session is undefined, enable
      browser session with default options.
    - Preserve current rum.webVitals behavior.

Task 3: Add Replay Startup Helper
  CREATE packages/logfire-browser/src/sessionReplay.ts:
    - Export BrowserSessionReplayOptions.
    - Implement startBrowserSessionReplay(options, browserSessionManager, replayState).
    - Load the replay package through options.load(); do not use a static
      import('@pydantic/logfire-session-replay') inside @pydantic/logfire-browser.
    - Pass through replayUrl, headers, token, sampling, privacy, capture,
      distinct id, fetch, URL redaction/suppression, and onError options.
    - Do not pass sessionIdleTimeoutMs or maxSessionDurationMs; browser session
      lifecycle is owned by rum.session.
    - Before starting replay, ensure the browser session exists through the
      normal configure/session setup path.
    - Pass getSessionId using BrowserSessionManager.peekSessionId(), not
      browserSessionManager.touch(), browserSessionManager.getSession(), or
      getBrowserSessionId() on every rrweb event.
    - If peekSessionId() returns undefined during startup, treat replay startup
      as failed configuration and report it through the best-effort error path
      rather than creating a replay-owned session.
    - Do not pass getTraceContext by default.
    - If the replay handle starts in a recording mode, call
      replayState.setReplay(replay) so spans read live mode.
    - On stop or failed startup, call replayState.clear().
    - Merge default ignore/suppression URL patterns for traceUrl,
      metrics.metricUrl, and replayUrl with any user-provided ignore patterns
      so browser SDK telemetry endpoints are not captured as replay network
      events. If the standalone replay package still lacks URL suppression, add
      it there instead of treating `redactUrlPatterns` as sufficient.
    - Separately merge default redactUrlPatterns with user-provided redaction
      patterns for caller-provided sensitive URLs that should remain visible as
      network events without query/hash detail.
    - Catch import/start failures, call diag.error with an install/config hint,
      call options.onError?.(error), and resolve undefined.
    - Return the SessionReplay handle when startup succeeds.
  PATTERN:
    - packages/logfire-browser/src/browserMetrics.ts for isolated optional-ish
      runtime startup and cleanup handle shape.
    - packages/logfire-browser/src/index.ts browserMetricsStartupPromise and
      webVitalsStartupPromise for memoized async startup.

Task 4: Wire Configure Lifecycle
  MODIFY packages/logfire-browser/src/index.ts:
    - Compute sessionReplayOptions before resolving browser session.
    - Configure browser session if replay or Web Vitals require it.
    - Create one BrowserSessionReplayState per configure() call and pass it to
      BrowserSessionSpanProcessor.
    - After tracerProvider.register(), create sessionReplayStartupPromise only
      when sessionReplay is configured.
    - Keep replay startup best-effort: trace setup should still succeed if
      replay import/start fails.
    - Cleanup order with replay configured:
      1. clear replay state, then await sessionReplayStartupPromise and stop
         replay if present
      2. unregister instrumentations
      3. shutdown Web Vitals
      4. force flush and shutdown browser metrics
      5. force flush and shutdown tracer provider
      6. clear browser session manager
    - Preserve cleanup promise identity and best-effort error aggregation.
  MODIFY packages/logfire-browser/src/BrowserSessionSpanProcessor.ts:
    - Accept an optional BrowserSessionReplayState in the constructor.
    - On onStart(), after session attributes are stamped, read replayState.getState().
    - If state is active, stamp:
      - logfire.session_replay.active = true
      - logfire.session_replay.mode = state.mode
    - Do not stamp replay state attributes when no replay is active or mode is off.

Task 5: Tests
  MODIFY packages/logfire-browser/src/browserSession.test.ts:
    - Assert peekSessionId() returns undefined before any session exists.
    - Assert peekSessionId() returns the in-memory id after touch() creates or
      updates a session.
    - Assert peekSessionId() does not read storage, write storage, update
      lastActivityAt, create an expired session replacement, or rotate the
      session.
  MODIFY packages/logfire-browser/src/index.test.ts:
    - Mock the local sessionReplay helper and/or pass a load callback.
    - Assert replay is not imported/started by default.
    - Assert sessionReplay: false does not start replay.
    - Assert enabled replay passes replayUrl, headers, token, sampling, privacy,
      capture, distinct id, fetch, load, redaction options, and network
      suppression options through.
    - Assert enabled replay implies BrowserSessionSpanProcessor.
    - Assert rum.session: false plus sessionReplay throws.
    - Assert getSessionId passed to replay returns the same id as
      getBrowserSessionId() / BrowserSessionSpanProcessor.
    - Assert replay getSessionId uses peekSessionId() and does not call
      touch(), getSession(), or getBrowserSessionId() on the rrweb hot path.
    - Assert getTraceContext is not passed by the browser integration.
    - Assert import/start failure calls diag.error and sessionReplay.onError,
      and does not prevent tracing setup.
    - Assert cleanup awaits replay startup and calls replay.stop() before
      unregister, metric force flush, trace force flush, and tracer shutdown.
    - Assert repeated cleanup calls do not stop replay more than once.
  MODIFY packages/logfire-browser/src/BrowserSessionSpanProcessor.test.ts:
    - Assert spans started after replay startup include
      logfire.session_replay.active and live logfire.session_replay.mode.
    - Assert mode changes from buffer to full are reflected on later spans.
    - Assert spans do not get replay state attributes before replay starts,
      after replay stop, or when replay mode is 'off'.
  MODIFY packages/logfire-session-replay/src/capture.test.ts:
    - Assert ignoreUrlPatterns suppress matching fetch and XHR events entirely.
    - Assert redactUrlPatterns still emit network events with query/hash removed
      for URLs that are not ignored.

Task 6: Documentation And Example
  MODIFY packages/logfire-browser/README.md:
    - Add sessionReplay example with proxy-first replayUrl + headers.
    - Explain that @pydantic/logfire-session-replay must be installed to enable
      replay.
    - Document direct token as an advanced escape hatch, not the default path.
    - Document privacy defaults and common capture toggles.
  MODIFY docs/packages/browser.md:
    - Mirror public config and proxy guidance for docs-site readers.
  MODIFY examples/browser/* if this branch's smoke example remains the chosen
  manual verification target:
    - Add optional replay proxy route.
    - Add commented or environment-gated sessionReplay config.
    - Make the example still run without replay configured.

Task 7: Build And Bundle Validation
  VERIFY no-replay browser builds:
    - Build/typecheck @pydantic/logfire-browser without enabling replay.
    - Verify the browser package does not gain rrweb/fflate in dependencies.
    - Verify a no-replay example build succeeds without a static browser package
      import of @pydantic/logfire-session-replay.
  VERIFY replay-enabled path:
    - Build/typecheck with @pydantic/logfire-session-replay installed in the
      workspace.
    - Run the browser example with both dev and proxy processes and confirm
      replay uploads use the shared browser session id.

Task 8: Changesets
  RUN pnpm run changeset-add:
    - Add release notes for @pydantic/logfire-browser sessionReplay config.
    - Add release notes for @pydantic/logfire-session-replay live mode on the
      SessionReplay handle.
```

### Integration Points

```yaml
CONFIG:
  - packages/logfire-browser/src/index.ts:
      Add sessionReplay?: false | BrowserSessionReplayOptions to LogfireConfigOptions.
      Make replay imply browser session attributes unless explicitly disabled.

OPTIONAL DEPENDENCY:
  - packages/logfire-browser/package.json:
      Add optional peer metadata for @pydantic/logfire-session-replay.
      Keep replay package out of browser dependencies.

RUNTIME STARTUP:
  - packages/logfire-browser/src/sessionReplay.ts:
      Dynamic import boundary and adapter from browser SDK session state to
      standalone replay config. Also updates browser replay state for spans.

CLEANUP:
  - packages/logfire-browser/src/index.ts:
      Clear replay state, then await replay startup and stop replay before
      unregister/exporter shutdown.

CORRELATION:
  - Browser spans:
      session.id and browser.session.id already come from PRP 020.
      Spans started while replay is active also get
      logfire.session_replay.active and logfire.session_replay.mode.
  - Replay chunks:
      Use the same session id through getSessionId.
      Do not populate trace ids from browser trace polling by default.
  - Platform/UI:
      Treat session id plus replay/span timestamps as authoritative.
      Do not treat replay trace_ids as the complete trace set for a session.
```

## Validation

Run these after implementation:

```bash
vp run @pydantic/logfire-browser#test
vp run @pydantic/logfire-browser#typecheck
vp run @pydantic/logfire-browser#build
vp run @pydantic/logfire-session-replay#test
vp run @pydantic/logfire-session-replay#typecheck
vp run --filter "./packages/*" test
pnpm run build
pnpm run check
```

Manual/browser verification, if the example is updated:

```bash
pnpm --filter browser run dev
pnpm --filter browser run proxy
```

Then in Logfire/Platform or the local proxy logs, verify:

- Replay uploads are sent to `{replayUrl}/{sessionId}?seq={seq}`.
- The `sessionId` in the replay upload path matches `session.id` /
  `browser.session.id` on browser spans.
- Spans started while replay is active include `logfire.session_replay.active`
  and `logfire.session_replay.mode`.
- Replay chunk `traceIds` are not populated by browser integration trace
  polling.
- Browser spans still arrive when replay import/start fails.
- Trace and metric exporter requests are not captured as replay network events
  during steady-state export or SDK shutdown.

### Required Test Coverage

- [x] `configure({ traceUrl })` does not load or start replay.
- [x] `configure({ sessionReplay: false, traceUrl })` does not load or start
      replay.
- [x] `configure({ sessionReplay: { replayUrl }, traceUrl })` starts replay and
      passes through user replay options.
- [x] Replay-enabled config implies browser session span processor.
- [x] `rum.session: false` with `sessionReplay` throws.
- [x] Replay `getSessionId` shares the SDK browser session id.
- [x] `BrowserSessionManager.peekSessionId()` returns the current in-memory id
      without storage I/O, expiry checks, writes, `lastActivityAt` updates,
      creation, or rotation.
- [x] Replay `getSessionId` uses `peekSessionId()` and does not call
      `browserSessionManager.touch()`, `browserSessionManager.getSession()`, or
      `getBrowserSessionId()` for every rrweb event.
- [x] Browser integration does not pass `getTraceContext` to replay.
- [x] Spans started while replay is active get replay state attributes.
- [x] Spans read live replay mode, including `buffer -> full` after an
      error-triggered upload.
- [x] Spans started before replay starts, after replay stops, or when replay is
      sampled off do not get replay state attributes.
- [x] Default replay ignore/suppression patterns cover configured trace, metric,
      and replay upload URLs, and tests prove those requests are not emitted as
      replay network events. Redaction-only behavior is not sufficient for this
      requirement.
- [x] No-replay browser build does not require the optional replay package to be
      resolved by the application bundler.
- [x] Replay import/start errors are reported and do not prevent trace setup.
- [x] Cleanup stops replay once, before unregister and exporter shutdown.
- [x] No-replay behavior for existing Web Vitals and browser metrics tests
      remains unchanged.

## Clarifications

### Session 2026-06-30

- Q: If `sessionReplay` is configured but the optional replay package cannot be
  imported, what should `configure()` do? -> A: Best-effort startup. Keep
  tracing running, log via `diag.error`, call `sessionReplay.onError`, and
  disable replay for that page lifecycle.
- Q: Where should the public browser config expose replay? -> A: Top-level
  `sessionReplay` only. Do not add a `rum.sessionReplay` alias in this PRP.
- Q: Should browser replay integration wire `getTraceContext` and populate
  replay `traceIds` from active-span polling? -> A: No. Active-span polling can
  create incomplete trace lists that look authoritative. Instead, replay should
  publish active recording state to the browser SDK, and the browser span
  processor should stamp replay state on spans. Authoritative correlation is
  shared `session.id` / `browser.session.id` plus replay/span timestamps.

## Unknowns & Risks

- Optional peer bundling remains the largest integration risk. The required
  `sessionReplay.load` callback avoids a static browser-package import, but the
  implementation still needs no-replay example build validation to prove normal
  tracing apps do not resolve `@pydantic/logfire-session-replay`.
- The public API location is recommended as top-level `sessionReplay`, matching
  the handoff document. A `rum.sessionReplay` alias is possible but would couple
  replay more tightly to the RUM object and may make defaults less obvious.
- Replay mode on spans is useful but not proof that a replay row exists. In
  `buffer` mode the replay may only be uploaded after an error. Platform UI
  should join to actual replay rows/chunks before showing "has replay".
- If exact span-to-replay timeline markers are needed later, use a follow-up PRP
  with deterministic span lifecycle markers and explicit volume/privacy controls.
  Do not reintroduce polling-based trace ids as authoritative correlation.
- Cleanup order around multiple monkey-patch owners must be verified in tests.
  Bad ordering can restore stale wrappers or leave replay/OTel hooks installed.
- Documentation must be clear that browser replay should use a backend proxy.
  Direct token config exists but should not be the recommended browser path.

**Confidence: 7/10** for one-pass implementation success. The core SDK wiring is
straightforward because PRPs 020 and 023 already provide the key primitives, but
optional peer bundling and monkey-patch cleanup order need careful validation.
