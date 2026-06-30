# Code Review — Browser RUM + Session Replay (pre-PR, comprehensive)

## Review Context

- **Branch:** `petyosi/browser-rum-web-vitals`
- **Base:** `origin/main` (`c8e87a2`)
- **Reviewed at:** `63ccc9d` (Integrate browser session replay)
- **Date:** 2026-06-30
- **Scope:** Exactly the 4 commits in `origin/main...HEAD` — the new `@pydantic/logfire-session-replay` package and the browser RUM / Web Vitals / session-replay integration in `@pydantic/logfire-browser`. The `logfire-api` Error.cause changes visible in `git diff main...HEAD` are **out of scope** (already merged on `origin/main`; local `main` is stale).
- **Method:** Full quality gates run on a clean reinstall, plus an 8-dimension adversarial review workflow (31 subagents: per-dimension finders → independent skeptical verification of every candidate finding). 23 candidates → 22 survived verification → deduped to the distinct issues below. Findings cross-checked against the live source, not against prose.
- **Relationship to prior report:** Supersedes/extends `reports/code-review-browser-rum-web-vitals.md` (earlier same-day pass, no subagents, gates not run). This pass **independently reproduces** all three of that report's findings (capture exception boundary, keepalive flush, stale docs) — corroboration noted inline — and adds new verified issues.

## Quality Gates

Run after a clean `CI=true pnpm install --frozen-lockfile`:

| Gate                            | Result                         |
| ------------------------------- | ------------------------------ |
| `pnpm run build`                | ✅ pass                        |
| `pnpm run typecheck`            | ✅ pass                        |
| `pnpm run test`                 | ✅ pass — 654 tests / 51 files |
| `pnpm run lint` (oxlint)        | ✅ pass                        |
| `pnpm run format-check` (oxfmt) | ✅ pass                        |

All findings below are logic / concurrency / privacy / packaging / design issues that the green gates cannot catch.

## Verdict

Well-architected branch. The optional-peer lazy loading, the compile-time `assertReplayConfigAssignable` conformance check, and the synchronous-capture-before-rotate transport design are all sound; the transport's seq / rotate / session-id handling was traced and is **correct** (in-flight flushes capture `sessionId`/`seq` synchronously before `rotate()` reassigns them). The issues are at the edges: one latent privacy-control defeat, a few real but narrow bugs, and a default-posture/docs gap that a session-replay product should resolve before a user-facing release.

## Findings Summary

| #   | Severity | Verdict   | Finding                                                                                                                                                                                                                                       | Location                                                                                                                        |
| --- | -------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | High     | Confirmed | `redactUrlPatterns`/`ignoreUrlPatterns` defeated by stateful `RegExp` (`/g`/`/y` flag → `lastIndex` carryover) — URLs that should be redacted/ignored leak intermittently                                                                     | `packages/logfire-session-replay/src/capture.ts:367,381`                                                                        |
| 2   | Medium   | Confirmed | Sampling mode re-rolled on every page load while session id + upload seq persist → one continuous session records inconsistently across navigations when `sampleRate < 1`                                                                     | `packages/logfire-session-replay/src/index.ts:44`                                                                               |
| 3   | Medium   | Confirmed | fetch success-path `emit()` is inside the `try`; a throwing emit is misclassified as a network failure and **rejects the host's successful `fetch`**                                                                                          | `packages/logfire-session-replay/src/capture.ts:119`                                                                            |
| 4   | Medium   | Confirmed | Web Vitals metrics emit raw `url.path` as a default histogram dimension, copied outside the `attributes:false` opt-out → unbounded cardinality, not disableable as documented                                                                 | `packages/logfire-browser/src/index.ts:290`, `browserMetrics.ts:205`                                                            |
| 5   | Medium   | Confirmed | Final keepalive flush can exceed the browser ~64 KiB keepalive-body cap → unload/tail chunk (often the `FullSnapshot`) silently dropped, with a persisted seq gap; no retry/`sendBeacon` fallback                                             | `packages/logfire-session-replay/src/transport.ts:133`, `index.ts:157`                                                          |
| 6   | Medium   | Confirmed | Session-replay README states the browser integration is an unshipped "follow-up PRP" and references `rum.sessionReplay`, contradicting the top-level `sessionReplay` this branch ships                                                        | `packages/logfire-session-replay/README.md:121`                                                                                 |
| 7   | Medium   | Plausible | `captureNavigation` (on by default) emits full `window.location.href` on every push/replace/pop with no redaction/ignore applied                                                                                                              | `packages/logfire-session-replay/src/capture.ts:73`                                                                             |
| 8   | Medium   | Plausible | Privacy defaults are more aggressive than the README's "conservative" claim: `captureNetwork` + `captureConsole` on by default, `redactUrlPatterns` empty, `sessionSampleRate`/`onErrorSampleRate` = 1 (100% full capture)                    | `packages/logfire-session-replay/src/types.ts:170-184`                                                                          |
| 9   | Low      | Plausible | webVitals module singletons (`startupPromise`/`startupHasMetricRecorder`) never reset on shutdown → re-`configure()` silently drops Web Vitals metrics, or hard-throws via `assertBrowserWebVitalsMetricsCanStart()`                          | `packages/logfire-browser/src/webVitals.ts:223`                                                                                 |
| 10  | Low      | Plausible | Replay identity is slaved to `peekSessionId()`, which never re-reads storage or checks expiry → idle/max-duration expiry not enforced while spans are quiet                                                                                   | `packages/logfire-browser/src/sessionReplay.ts:171`                                                                             |
| 11  | Low      | Plausible | Synchronous `sessionStorage` read+parse+stringify+write on hot paths: `session.touch()` per rrweb event (standalone) and `BrowserSessionSpanProcessor.onStart` `touch()` per span                                                             | `session.ts:45`, `BrowserSessionSpanProcessor.ts:50`                                                                            |
| 12  | Low      | Confirmed | Docs cleanup-order list omits the metrics force-flush/shutdown and the session-replay shutdown that actually run                                                                                                                              | `docs/packages/browser.md:399`                                                                                                  |
| 13  | Low      | Mixed     | Test quality: real 50 ms timers gate fire-and-forget async-gzip flushes (flake risk); fuzzy assertions where deterministic; `console` restored without try/finally; untested cleanup-precedence / recorder-catch / sampling-boundary branches | `transport.test.ts:59`, `index.test.ts:310`, `capture.test.ts:16,48`, `browser/index.test.ts:308`, `browserMetrics.test.ts:275` |

---

## Must-fix before merge

### 1. (High, privacy) Stateful `RegExp` defeats URL redaction / ignore — `capture.ts:367,381`

`redactUrl` and `shouldIgnoreUrl` call `pattern.test(url)` on the **same** user-supplied `RegExp` instance for every captured request:

```ts
function redactUrl(url, patterns) {
  if (patterns.length === 0 || !patterns.some((pattern) => pattern.test(url))) return url
  ...
}
function shouldIgnoreUrl(url, patterns) {
  return patterns.some((pattern) => pattern.test(url))
}
```

The resolved config stores the user's arrays verbatim (`index.ts:193-194`) with no flag normalization. If a consumer writes the very natural `redactUrlPatterns: [/token=/g]`, the `/g` (or `/y`) flag makes `RegExp.prototype.test` **stateful**: a successful match advances `lastIndex`, so the next `test()` on a different URL resumes from that offset and can return `false` even when the substring is present (then resets to 0). The result is non-deterministic, offset-dependent leakage — a URL that _should_ be redacted is captured and uploaded raw; an `ignoreUrlPatterns` entry with `/g` intermittently fails to drop a sensitive endpoint.

Internal patterns (`createUrlPrefixPattern`, built with flag `u`) are safe; only user-supplied `redactUrlPatterns`/`ignoreUrlPatterns` are at risk. Existing tests use single requests with `/u` patterns, so they never exercise the stateful path.

**Fix:** normalize flags once when resolving config (`new RegExp(p.source, p.flags.replace(/[gy]/gu, ''))`), or reset `lastIndex = 0` before each test. Add a test with a `/g` pattern across ≥2 URLs.

### 2. (Medium, bug) Sampling mode re-rolled per page load while session + seq persist — `index.ts:44`

`session.id` and the upload `seq` survive a same-tab reload / MPA navigation via `sessionStorage`, but `startSessionReplay()` runs `decideSamplingMode()` fresh on each load. With `sessionSampleRate: 0.5`, a session can roll `full` on page A (uploads seq 0,1,2) then roll `off`/`buffer` on page B — producing a broken/partial replay for one continuous session. The persistence of id + seq implies sessions are meant to span loads.

**Fix:** persist the chosen `SamplingMode` alongside `SessionState` in `sessionStorage`; on startup reuse the stored mode for a still-valid session and only roll a new mode when a new session is created.

### 3. (Medium, bug) A throwing `emit()` on the fetch success path rejects the host's request — `capture.ts:119`

```ts
try {
  const response = await original(input, init)
  emit(CustomTag.Network, createNetworkPayload({ ...status: response.status... })) // success emit INSIDE try
  return response
} catch (error) {
  emit(CustomTag.Network, createNetworkPayload({ ...status: 0, failed: true... }))
  throw error
}
```

If the success-path `emit` throws (e.g. `recorder.addCustomEvent` on an in-flight request after `stop()`), control falls into `catch`, which emits a spurious `failed:true` event and `throw error` — rejecting the caller's otherwise-successful `fetch`. `captureConsole` deliberately isolates emit ("Never let capture break host logging"); the fetch path missing the same guard is an oversight. **This corroborates finding #1 of the prior report**, which also flagged the XHR and navigation paths.

**Fix:** wrap the success-path `emit` in its own try/catch (a shared `safeEmit` helper that reports via `onError` and is used by fetch, XHR, and navigation paths is the cleanest form).

### 4. (Medium, cardinality) Raw `url.path` default metric dimension, not disableable — `index.ts:290` + `browserMetrics.ts:205`

`createWebVitalsMetricDefaultAttributes` (`index.ts:276-295`) adds `url.path = window.location.pathname` to every Web Vitals histogram. In `createWebVitalsMetricRecorder` the `defaultAttributes` are copied **unconditionally** (`browserMetrics.ts:205`), _before_ the `options.attributes !== false` guard (`:206`), and `url.path` is not in `DISALLOWED_WEB_VITAL_METRIC_ATTRIBUTES`. For routes with ids in the path (`/users/12345`), every distinct pathname becomes a separate time series across all 5 histograms × rating — unbounded cardinality on the metrics backend, with no way to turn it off short of supplying a custom templating `rum.session.urlAttributes`. (The example's `urlAttributes` returns raw `pathname` too, so it does not mitigate this.)

**Fix:** don't emit raw `url.path` as a default metric dimension; either drop it, add it to the disallow set, or move the `defaultAttributes` copy behind the `attributes !== false` opt-out and document that callers must supply a low-cardinality templated path.

### 5. (Medium, bug) Final keepalive flush can silently drop the tail chunk — `transport.ts:133`, `index.ts:157`

`onHide`/`shutdown` flush with `keepalive: true`. Browsers cap aggregate in-flight keepalive bodies at ~64 KiB. With `maxBufferBytes` defaulting to 1 MB uncompressed, a heavy page that closes within the 5 s flush window can produce a gzipped body > 64 KiB → `fetch` rejects, `maxAttempts = 1` for keepalive means no retry and there is no `navigator.sendBeacon` fallback. The `seq` was already advanced and persisted (`transport.ts:76-79`), so the server also sees a permanent gap. The lost chunk frequently holds the `FullSnapshot`, making the short session unreplayable. **Corroborates finding #2 of the prior report.**

**Fix:** split the keepalive flush into <64 KiB chunks (each its own seq) or fall back to `sendBeacon`; reserve keepalive for genuine lifecycle exits and let explicit `stop()` on a live page use a normal flush; surface truncation via `onError`.

---

## Privacy & default posture — confirm intent before release

None are bugs; they are product decisions a session-replay feature should sign off on. The README ("The defaults are conservative") understates what is captured out of the box.

- **#8 Network capture on by default**, `redactUrlPatterns: []` → full request URLs **including query strings** (bearer tokens, session ids, reset links, emails) captured for fetch _and_ XHR (`types.ts:181`).
- **#8 Console capture on by default** → up to 10 args per call (objects `JSON.stringify`'d, truncated to 1024) captured with no scrubbing (`types.ts:181`).
- **#7 `captureNavigation` emits full `window.location.href`** on every push/replace/pop with no redaction/ignore (`capture.ts:73`) — inconsistent with network redaction. (Partial mitigation only: rrweb Meta events also carry the URL, so redacting the custom navigation event alone does not fully prevent URL capture.)
- **#8 100% full-session sampling by default** (`sessionSampleRate: 1`, `onErrorSampleRate: 1`, `types.ts:171`) — surprising cost/privacy default, undocumented.

**Recommendation:** tighten the defaults and/or make the README Privacy section state plainly that URLs (with query strings) and console output are captured and are not redacted unless configured, and that the default samples 100% of sessions in full.

---

## Lower-severity correctness & robustness

- **#9 `webVitals.ts:223` singletons never reset on shutdown** — `startupPromise ??= import(...)` short-circuits after cleanup, so a second `configure()` in the same page (HMR, tests, reconfigure) never re-wires the new `metricRecorder` and Web Vitals metrics silently stop; configuring webVitals-without-metrics then webVitals-with-metrics can make `assertBrowserWebVitalsMetricsCanStart()` throw for the page's lifetime. `resetBrowserWebVitalsForTests()` exists, signaling awareness — consider resetting in the cleanup path or re-pointing the report closure at the current recorder.
- **#10 `sessionReplay.ts:171` replay identity uses `peekSessionId()`**, which never re-reads storage or checks expiry, so idle/max-duration expiry is not enforced during pure-replay activity with no spans firing. Minor semantic drift (the span processor and `getBrowserSessionId()` do enforce expiry whenever they run).
- **#11 Hot-path `sessionStorage` I/O** — `session.touch()` per rrweb event (standalone mode only; the integrated path uses external `peekSessionId` and skips this) and `BrowserSessionSpanProcessor.onStart` `touch()` per span each do a synchronous read+parse+stringify+write. Low impact, avoidable with an in-memory cache + throttled persistence.

---

## Docs

- **#6 `packages/logfire-session-replay/README.md:110-123` is stale** — "## Browser SDK Integration … That integration is a follow-up PRP. Until then, call `startSessionReplay()` directly" and the `rum.sessionReplay` reference contradict the top-level `sessionReplay` integration this branch ships. The main `docs/packages/browser.md` is correct. **Corroborates finding #3 of the prior report.**
- **#12 `docs/packages/browser.md:399`** cleanup-order list omits the metrics force-flush/shutdown and the session-replay shutdown that the actual `configure()` teardown runs. Align cleanup examples across the package README and docs site to cover client + metrics + replay.

---

## Tests (quality, per the project's exact-assertion guidance)

- **Flake risk:** `transport.test.ts:59` and `index.test.ts:310` gate fire-and-forget gzip flushes on a real 50 ms `setTimeout` (`settle()`) instead of awaiting the actual flush promise → races fflate's async gzip under CI load. Prefer awaiting the real promise or fake timers.
- **Weak assertions:** `capture.test.ts:48` uses fuzzy `toBeLessThan`/`toMatch` where the truncated length and value are fully deterministic — contrary to the project's exact-assertion guidance.
- **Cross-test pollution:** `capture.test.ts:16` restores `console.warn` without try/finally; an assertion failure leaks a patched console method into sibling tests.
- **Untested branches that matter:** cleanup first-error-wins precedence and continue-after-failure (`browser/index.test.ts:308`); recorder `record()` diagnostics catch path (`browserMetrics.test.ts:275`); sampling `<` boundary (`random()` exactly equal to the rate).

---

## Verified clean / not findings

- **Transport ordering is correct.** `flush()` captures `events`/`seq`/`sessionId` synchronously before `rotate()` reassigns `this.sessionId`/`this.seq`, and serializes deliveries through the `this.flushing` chain — in-flight chunks keep the right session id and seq; no wrong-session or double-seq race.
- **Cross-session seq resume is sound.** `loadSeq(newSessionId)` returns 0 on id mismatch; `saveSeq` keys on the current session.
- **External dependencies are not inlined** into `@pydantic/logfire-session-replay/dist` — `rrweb` and `fflate` remain runtime imports (verified in the prior report's build check; consistent with `deps.neverBundle` / package `dependencies`).
- **uuidv7** byte layout, 48-bit big-endian timestamp, and version/variant bits are correct.
- **Changesets** match the changed packages and bump levels (4 × `@pydantic/logfire-browser` minor, 2 × `@pydantic/logfire-session-replay` minor for its initial release from `0.0.0`).
- **No Node-only APIs** in shipped `src/`; `startSessionReplay` guards on `window`/`document` undefined for SSR safety.

---

## Recommended action

The top cluster is cheap to fix and worth doing before opening the PR: **#1** (regex flag normalization), **#3** (success-path emit guard), **#2** (persist sampling mode), **#4** (drop/gate `url.path` metric dimension), plus the two doc spots (**#6**, **#12**). **#5** (keepalive) and the privacy-default decisions (**#7**, **#8**) are the next tier — at minimum, decide and document the default posture. Everything else can be a tracked follow-up.
