# Review: PR #161 — Release browser RUM and session replay

Reviewed: 2026-07-13. Scope: the PR diff (74 files, +11,214/−72) against `main`.

## Overview

The PR graduates the alpha-track work to stable: a new standalone `@pydantic/logfire-session-replay` package (rrweb recorder with per-session sampling, buffer/full modes, gzip chunked transport, console/network/navigation capture), major additions to `@pydantic/logfire-browser` (sessionStorage-backed RUM session identity stamped on every span, Web Vitals spans plus optional OTel histogram metrics, and an opt-in replay integration with SDK-owned session correlation), a new `examples/browser-rum-replay`, exit from Changesets prerelease mode, and removal of the branch-specific alpha publisher.

The claimed version math checks out: running `changeset version` on the branch state in an isolated worktree produces exactly `@pydantic/logfire-browser@0.17.0` and `@pydantic/logfire-session-replay@0.1.0` with no stray public packages.

**Overall**: code quality is high — transactional startup/cleanup, memoized idempotent teardown, third-party-wrapper-safe monkey-patching, ~185 tests. But six major issues were found and verified, and three of them are triggered by exactly the configuration the docs recommend (relative proxy URL + `autoInstrumentations: true` + replay). Since this PR is the stable-release gate, the majors should be fixed before merging.

## Major findings (all verified against the code)

### 1. Replay records the SDK's own OTLP exports when telemetry URLs are relative

`packages/logfire-browser/src/sessionReplay.ts:274` (`createUrlPrefixPattern`)

`createTelemetryIgnorePatterns` builds `^`-anchored regexes from the raw configured `traceUrl`/`metricUrl`/`replayUrl`. But the OTLP fetch transport absolutizes the URL (`new URL(url, location.href).href`) before fetching, and the replay capture matches patterns against the raw fetch argument with no normalization. With the doc-recommended `traceUrl: '/logfire-proxy/v1/traces'`, the pattern `^\/logfire-proxy...` never matches the absolute request URL, so every trace/metric export batch becomes a replay network event — self-sustaining upload cycles on idle pages, which is precisely what the suppression exists to prevent. The only test covers relative-vs-relative.

**Fix**: normalize both sides via `new URL(url, location.href).href` (keeping the raw form for directly-issued relative requests).

### 2. Replay's fetch wrapper hides `__original`, re-enabling the OTLP export→span→export loop

`packages/logfire-session-replay/src/capture.ts:352` (`patchMethod`)

`@opentelemetry/otlp-exporter-base`'s fetch transport deliberately unwraps `globalThis.fetch.__original` (set by instrumentation-fetch) to break the "Export → Span → Export endless loop" (its own comment, `fetch-transport.js:43-49`). `patchMethod` installs the replay wrapper without propagating `__original`, and since replay loads async it lands outermost. Result with `autoInstrumentations` + replay (the new example's exact setup): the exporter can't bypass instrumentation, every export batch creates a span, which gets exported, forever — and each loop span also calls `sessionManager.touch()`, so RUM sessions never idle out.

**Fix**: have `patchMethod` copy `original.__original ?? original` onto the wrapper; also consider injecting default `ignoreUrls` (absolute-normalized trace/metric/replay URLs) into the fetch/XHR auto-instrumentation configs from `configure()`.

### 3. Teardown-then-reconfigure silently drops all manual `logfire.*` spans

`packages/logfire-browser/src/index.ts:543` (cleanup)

Cleanup shuts the provider down but never calls `trace.disable()`/`context.disable()`. The OTel API's global registry refuses overrides, so the second `configure()`'s `register()` is a diag-error no-op and the global keeps delegating to the shut-down first provider. Manual API spans vanish while Web Vitals spans and instrumentations (direct provider references) keep working — a confusing partial outage in an explicitly advertised flow ("SPA shells that replace the whole telemetry setup"). The test suite masks this because the mocked provider calls `trace.disable()` in `shutdown()` (`index.test.ts:98`), which the real `WebTracerProvider` does not.

**Fix**: guardedly call `trace.disable()`/`context.disable()`/`propagation.disable()` in cleanup when this configure's provider is still the registered one.

### 4. Multi-chunk keepalive flush delivers only the first chunk on real unload

`packages/logfire-session-replay/src/transport.ts:94`

The keepalive flush splits events into ~48KB chunks but `await`s each chunk's fetch _response_ before initiating the next. On a genuine navigation/close, the page dies while awaiting chunk 0's response, so chunks 1..n are never even started — the splitting mechanism fails in exactly the large-buffer unload case it was built for. The README's caveat only covers the single-oversized-event case.

**Fix**: initiate keepalive fetches without awaiting between them (minding the cumulative ~64KiB keepalive quota), or fall back to `navigator.sendBeacon`.

### 5. Periodic uploads depend on Worker+`blob:` gzip with no fallback

`packages/logfire-session-replay/src/transport.ts:163`, `gzipAsync` at `:309-319`

Non-keepalive delivery uses fflate's async `gzip`, which unconditionally spawns a `Worker` from a Blob URL (verified in fflate 0.8.3's browser build). Under a CSP without `worker-src blob:` (common in the security-conscious apps that deploy replay proxies), every 5-second flush rejects and the already-swapped-out buffer is silently dropped — replay records nothing, forever, while keepalive flushes (which use `gzipSync`) succeed.

**Fix**: catch the worker failure and fall back to `gzipSync`, memoizing the decision.

### 6. The Version Packages PR will commit `"version": null`

`examples/nextjs/package.json`

Empirically reproduced: `examples/nextjs` has no `version` field (its siblings carry `"0.0.0"`), and the changesets exit-mode path force-patches it via `semver.inc(undefined, 'patch')` → `null`, plus a junk `## null` CHANGELOG. Root cause: `@changesets/should-skip-package` excludes it from `preVersions`, and the exit-mode loop in `@changesets/assemble-release-plan` (v6.0.9) force-adds a patch release whenever `preVersions.get(name) !== 0` without re-checking `shouldSkipPackage`. The PR body anticipates hand-editing the release PR; adding `"version": "0.0.0"` here is the cleaner fix.

## Minor findings

### Session replay package

- `src/index.ts:217`: `handleError` doesn't re-check `active` after `addCustomEvent` (which can trigger session rotation mid-call), so `triggerFlush()` restarts an interval on a deactivated transport that nothing ever clears — a page-lifetime timer leak plus one post-rotation upload of buffered old-session events.
- `src/transport.ts:57`: `maxBufferBytes` is enforced only in full mode; buffer mode's in-memory buffer is unbounded in bytes between 120-second checkouts.
- `src/session.ts:44`: with no external `getSessionId`, every rrweb event triggers `touch()` — synchronous `sessionStorage` read + parse + stringify + write per event. Debounce `lastActivityAt` persistence to ~1/sec.
- `src/transport.ts:108`: `rotate()` and `RecorderHandle.takeFullSnapshot` (`recorder.ts:65`) are dead production code with tests asserting behavior nothing ships (`transport.test.ts:255-333`). Delete or wire up before 0.1.0.
- `src/capture.ts:25`: no reentrancy guard — a persistently-throwing emit plus a console-logging `onError` recurses to stack overflow inside the host app's console call.
- `src/types.ts:66`: `NavigationPayload.kind` includes `'load'`, which is never emitted (`captureNavigation` emits only push/replace/pop).
- `src/transport.ts:278`: `estimateBytes` counts UTF-16 code units, not bytes, undercounting multibyte content against `maxBufferBytes` and the keepalive chunk thresholds.
- `src/index.ts:225-227`: a rejection reason like `{message: 123}` passes a non-string `message` into a payload typed `message: string`; `String(...)` coercion would honor the type.
- `capture.test.ts:5` imports from `'vite-plus/test'` while every other test imports from `'vitest'`.

### Browser package

- `src/webVitals.ts:196`: final CLS/INP/LCP callbacks routinely fire after SPA teardown (on `pagehide`/`visibilitychange`) and produce recurring `diag.error` noise; should drop silently post-shutdown.
- `src/index.ts:526`: a metrics-transport failure also kills the Web Vitals _spans_ path when `rum.webVitals.metrics` is enabled; degrading to spans-only with a diag warning would be friendlier. Untested path.
- `src/BrowserSessionSpanProcessor.ts:54`: `replayState?.getState()` reads getters from the user-loaded module unguarded in the span hot path — a throwing getter breaks every `startSpan()` app-wide (the adjacent `getUrlAttributes` is try/caught).
- `src/BrowserSessionSpanProcessor.ts:50`: `touch()` performs synchronous `sessionStorage` read+write on every span start; chatty auto-instrumented pages pay double storage I/O per span.
- `src/webVitals.ts:201`: Web Vitals spans carry no `logfire.span_type: 'log'` despite being point-in-time events — confirm the platform special-cases `web_vital.*` names, otherwise stamp the attribute.
- `src/index.ts:228`: empty `metrics.metricUrl` throws synchronously; empty `sessionReplay.replayUrl` fails only asynchronously with a diag error. Validate both up front.
- `src/browserSession.ts:135`: replay correlates via `peekSessionId()` (no expiry check), so a user active in the page but producing no spans keeps uploading replay chunks under a session RUM considers expired. Deliberate trade-off, but document that "inactivity" means span inactivity.
- No public replay handle (`flush`/`stop`/`mode` never exposed — `sessionReplay.ts:243`): apps can't flush before a critical navigation. Additive later, but worth a deliberate decision at 0.17.0.
- API-shape note: `sessionReplay` sits at top level while `webVitals` sits under `rum`, though both imply `rum.session`. Defensible, noting the asymmetry for a stable release.

### Release / examples / docs

- The stable 0.17.0 changelog won't mention `autoInstrumentations` — the alpha-era minor changeset describing it was replaced by the patch-level `stable-browser-rum-lifecycle` with different text, yet the docs teach it as the primary pattern. Restoring a minor changeset line doesn't change the version math.
- `examples/browser/src/proxy.ts:96-111`: no try/catch (unlike its `browser-rum-replay` twin) — an upstream fetch rejection crashes the proxy on Node ≥15.
- `pnpm run proxy` fails on a fresh clone without a `.env` file (`tsx --env-file=.env`, both examples); use `--env-file-if-exists=.env` (Node 24 supports it) and commit an `.env.example` for `examples/browser` too.
- Both vite configs string-replace `from"rrweb"` in the built replay dist — silently no-ops if build formatting changes; neither README states that a root `pnpm run build` is required before `pnpm run dev`.
- `examples/browser/src/proxy.ts:16`: default `LOGFIRE_URL` changed from standard OTLP `localhost:4318` to the internal dev-stack `localhost:3000` — a dead-end default for external users of a public example.

## Security

- **Replay capture defaults are the biggest decision in the PR** (`packages/logfire-session-replay/src/types.ts:182`): all visible DOM text is recorded (`maskTextSelector: ''`), full URLs including query strings (`redactUrlPatterns: []`), and console args are captured by default. Inputs _are_ masked (`maskAllInputs: true`) and bodies never captured, and the README discloses everything — but Sentry defaults to masking all text, and there isn't even a `maskAllText` convenience option. This zero-config posture deserves an explicit sign-off before stable.
- `scripts/create-npm-token.sh:63` passes the token as a CLI argument to `gh secret set` (visible via `ps`); pipe it via stdin instead. Otherwise the script is a clear improvement (90-day expiry, mktemp + EXIT trap, no terminal echo).
- Example proxies use `cors({ origin: '*', credentials: true })` on token-bearing endpoints and listen on all interfaces — pre-existing pattern, but these are the reference for the documented proxy-first architecture; add a README warning. Nit: `?seq=${req.query.seq}` is interpolated unencoded.
- Clean: no write token ever reaches browser code; `.env` files gitignored; replay upload headers lock `Content-Type`/`Content-Encoding`; session IDs URL-encoded; lockfile additions all trace to rrweb 2.1.0 / fflate 0.8.3 / web-vitals 5.3.0 / jsdom (dev) — nothing suspicious.

## Test coverage

Strong overall: lease ownership, stop/rotation races, sampling persistence across page loads, keepalive-vs-ordinary flush concurrency, chunk splitting, third-party wrapper coexistence, throwing-callback containment, partial Web Vitals observer registration + retry. Gaps that map to the majors:

- No test matches ignore patterns against absolute-normalized exporter URLs (would have caught major 1); no integration-style test of the fetch-wrapper interplay (major 2).
- `index.test.ts:98`: the provider mock calls `trace.disable()` in shutdown, diverging from real OTel semantics and masking major 3. A configure→cleanup→configure test against the real `@opentelemetry/api` registry would catch it.
- `transport.test.ts:109`: the `maxBufferBytes` auto-flush test only asserts after `shutdown()`, so it passes even if the byte trigger is deleted.
- Untested paths: metrics-startup failure with `rum.webVitals.metrics` enabled; cleanup while replay startup is in flight; `SessionManager` fallback when storage throws (private mode); end-to-end `maskAllInputs` default through `resolveConfig`.
- Convention deviation: several `toMatchObject`/`objectContaining` assertions (`transport.test.ts:69,93`, throughout `capture.test.ts`) where the repo guide prefers exact `toEqual` with deterministic inputs.

## Release mechanics (verified empirically)

- `changeset version` produces browser `0.17.0` + replay `0.1.0`, deletes `pre.json` and all changeset files, and touches no other public package (`logfire@0.20.1`, `logfire-node@0.18.3`, cf-workers at 2.0.0 untouched). The stale `browser-rum-lifecycle` entry in `pre.json` is mechanically harmless in exit mode.
- No leftover alpha machinery in the repo (`git diff main...HEAD -- .github/` is empty; no `alpha` references in `.github/`, `scripts/`, or `package.json`). On npm, replay's `latest` dist-tag currently points at `0.1.0-alpha.1` — self-heals on stable publish; the `alpha` dist-tags can optionally be removed.
- `.changeset/config.json`'s `onlyUpdatePeerDependentsWhenOutOfRange: true` is correct and necessary for the new optional `workspace:^` peer edge (browser → replay). Heads-up: when replay hits 0.2.0, `^0.1.0` goes out of range and changesets will propose a **major** browser bump — expected, but worth knowing.
- Packaging is clean: replay publishes via `pnpm publish` so `catalog:`/`workspace:^` protocols are rewritten; `publishConfig.access: public`; `files` limited to `dist` + LICENSE.

## Recommended before merge

1. Fix majors 1-3 (they break the documented flagship configuration) and 4-5 (core delivery-path robustness) — all have contained fixes.
2. Add `"version": "0.0.0"` to `examples/nextjs/package.json`.
3. Make an explicit decision on text-masking defaults (or add `maskAllText`).
4. Restore an `autoInstrumentations` release-note line and delete the dead `rotate()`/`takeFullSnapshot` surface.
