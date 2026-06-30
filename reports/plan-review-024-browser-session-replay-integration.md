# Plan Review — Browser Session Replay Integration (PRP 024)

**Plan:** `plans/024-browser-session-replay-integration.md` (541 lines)
**Branch:** `petyosi/browser-rum-web-vitals` → `main`
**Reviewed at:** `571e95a` (Keep expected test warnings quiet)
**Date:** 2026-06-30
**Scope:** Completeness, wrong assumptions, and risky ideas — validated against the live code in `packages/logfire-browser/` and `packages/logfire-session-replay/`, not against the plan's own prose.
**Method:** Cross-checked every file/function/option the plan names against the actual source (`index.ts`, `browserSession.ts`, `BrowserSessionSpanProcessor.ts`, the replay package's `index.ts`/`types.ts`/`transport.ts`/`sampling.ts`/`capture.ts`), the test harness, the example, the root scripts, and the pnpm catalog.

## Verdict

The **core architecture is sound** — stamping replay state onto OTel spans and refusing to poll trace ids into replay is the right call, and it is consistent with how the replay package actually behaves when `getTraceContext` is omitted. But the plan rests on **two incorrect assumptions about the replay package's runtime behavior**, has a **gap in its task list around the central mechanism**, and **commits to a public API shape it simultaneously flags as its top risk**.

## Summary

| #   | Finding                                                                                                       | Location (plan / code)                                                  | Class            | Severity |
| --- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------- | -------- |
| 1   | Replay `mode` is dynamic (`buffer→full` on first error); plan caches it once → stale span attributes          | plan 263-277, 332-335 / `transport.ts:60-66`, `index.ts:95-100`         | Wrong assumption | High     |
| 2   | Core change — `BrowserSessionSpanProcessor` edit to stamp `logfire.session_replay.*` — is not a task          | plan Task 4 / `BrowserSessionSpanProcessor.ts:32,44-67`                 | Incompleteness   | High     |
| 3   | Plan commits to a no-loader dynamic-import API while naming optional-peer bundling its #1 risk                | plan 230-233, 300-336, 522-524                                          | Risky idea       | High     |
| 4   | `sessionIdleTimeoutMs`/`maxSessionDurationMs` are dead options when the SDK owns `getSessionId`               | plan 215-216 / `index.ts:52-63`                                         | Wrong assumption | Medium   |
| 5   | Span-attribute assertions routed to `index.test.ts`, which fully mocks the provider (no real spans)           | plan Task 5 / `index.test.ts` `vi.mock('@opentelemetry/sdk-trace-web')` | Incompleteness   | Medium   |
| 6   | Replay records the OTLP trace/metric exporters as network events in steady state, not just at shutdown        | plan 160-162, 481-483 / `capture.ts:95-138`, `index.ts:159`             | Incompleteness   | Medium   |
| 7   | `getSessionId: () => …touch().id` runs per rrweb event → per-event sessionStorage I/O; RUM never idles        | plan 330 / `index.ts:68-73`, `browserSession.ts:135-215`                | Risky idea       | Medium   |
| 8   | Local `BrowserSessionReplayOptions` hand-mirrors the whole replay config with no anti-drift guard             | plan 188-228                                                            | Incompleteness   | Medium   |
| 9   | No changeset task for either package; `mode` on the replay handle is package-visible                          | plan Validation / CLAUDE.md changeset rule                              | Incompleteness   | Low–Med  |
| 10  | Example filter name wrong (`browser-example` vs `browser`), proxy process omitted, `vp check <paths>` invalid | plan 462, 469 / `examples/browser/package.json`, `vp --help`            | Wrong assumption | Low      |
| 11  | Inherited staleness from `docs/session-replay-integration.md` (spanProcessors, XHR, rrweb pin)                | plan 120-121 / handoff 189-198, 364; `capture.ts:149`; catalog          | Wrong assumption | Low      |
| 12  | Optional-peer range vs. unpublished `0.0.0` package is unspecified                                            | plan 25, Task 1 / `logfire-session-replay/package.json:27`              | Incompleteness   | Low      |

---

## Wrong assumptions

### 1. (High) Replay `mode` is dynamic, but the plan treats it as a startup constant

The plan's span-attribute mechanism reads `mode` once during startup and caches it: `startBrowserSessionReplay` calls `replayState.setActive(mode)` (Task 3, plan 332-335), and `BrowserSessionReplayState` stores a single immutable `{ active, mode }` (plan 263-277).

The mode is not fixed. `ReplayTransport.triggerFlush()` upgrades `buffer → full` on the first error:

```ts
// packages/logfire-session-replay/src/transport.ts:60-66
async triggerFlush(): Promise<void> {
  if (this.mode === 'buffer') {
    this.mode = 'full'   // runtime transition
    this.start()
  }
  return this.flush()
}
```

It is driven from the replay's `error`/`unhandledrejection` handlers (`index.ts:95-100`). A session that begins in `buffer` and then hits an error is now continuously recording **and a replay row definitely exists** — yet every span started afterward would still be stamped `mode: "buffer"`. That inverts the intended semantics: the spans most likely to have a real replay (post-error) get the most pessimistic label.

The standalone handle also exposes **no `mode` today** — `SessionReplay` is `{ recording, getSessionId, flush, stop }` (`index.ts:22-27`), and even `recording` is a static literal `true` (`index.ts:132`), not a getter. Task 1's "expose `readonly mode` … if needed" undersells this: it is definitely needed, and it must be a **live getter delegating to `transport.getMode()`**, not a captured constant.

**Fix:** make `mode` a getter on the handle; have `BrowserSessionSpanProcessor.onStart` pull the live value (the `replayState` reads the handle, or the replay invokes a transition callback that updates `replayState`). Delete the one-shot `setActive(mode)` design.

### 4. (Medium) `sessionIdleTimeoutMs` / `maxSessionDurationMs` are dead options under the integration

`BrowserSessionReplayOptions` exposes these (plan 215-216) and Task 3 forwards them. But when the SDK supplies `getSessionId`, the replay's internal `SessionManager` is never consulted for the id:

```ts
// packages/logfire-session-replay/src/index.ts:57-63
const getSessionId = (touch) => {
  const externalSessionId = resolvedConfig.getSessionId?.()
  if (externalSessionId !== undefined && externalSessionId.length > 0) {
    return externalSessionId // browser SDK id always wins
  }
  return touch ? internalSessions.touch().id : internalSessions.getSession().id
}
```

Rotation is then driven entirely by `transport.rotate(newId)` reacting to the browser id changing, so `internalSessions` (constructed at `index.ts:52` with those timeouts) is inert for identity. The real knobs are `rum.session`'s `idleTimeoutMs`/`maxDurationMs` (`browserSession.ts:8-28`). Drop these two from `BrowserSessionReplayOptions`, or document them as ignored when the SDK owns the session.

### 10. (Low) Example/validation command errors

- The example package is named **`browser`**, not `browser-example` (`examples/browser/package.json` → `"name": "browser"`); `pnpm --filter browser-example dev` (plan 469) won't resolve.
- Replay verification also needs the **separate proxy process** — the example splits `dev` (`vp dev`) and `proxy` (`tsx --env-file=.env src/proxy.ts`). The plan starts only `dev`.
- `vp check packages/… packages/…` (plan 462): `vp check` takes no path arguments per `vp --help` ("Run format, lint, and type checks"); the root `check` script calls bare `vp check`. Use `pnpm run check` or scoped `vp run …#test/#typecheck`.

### 11. (Low) Inherited staleness from `docs/session-replay-integration.md`

The plan cites this handoff as a source (plan 120-121); it now misleads:

- Claims upstream `logfire-browser` lacks `spanProcessors` (handoff 189-198) — it exists (`index.ts:147`, added in PRP 020).
- Says `captureNetwork` only wraps fetch (handoff 364) — XHR is wrapped now (`captureXhr`, `capture.ts:149`).
- Says pin rrweb to `2.0.1` (handoff 222-230) — the catalog is `rrweb: 2.1.0`.

Add a note that the handoff predates 020/023.

---

## Incompleteness

### 2. (High) The core behavioral change is not an explicit task

The headline feature — "spans started while replay is active get replay state attributes" — requires modifying **`BrowserSessionSpanProcessor`** to (a) accept `replayState` in its constructor and (b) read it in `onStart` to set `logfire.session_replay.active`/`.mode`. The current constructor takes only `sessionManager` (`BrowserSessionSpanProcessor.ts:32`), and `onStart` stamps only session/url attributes (`:44-67`). No task says "MODIFY BrowserSessionSpanProcessor"; Task 4 only says "pass it to" the processor. Add an explicit task — this is the crux of the PRP.

### 5. (Medium) Span-attribute tests are routed to the wrong file

Task 5 sends all replay tests to `index.test.ts`. That harness fully mocks the provider (`vi.mock('@opentelemetry/sdk-trace-web', … WebTracerProvider: mocks.MockWebTracerProvider)`), so **no real span is created** and `onStart` attributes can't be observed there. The "spans get `logfire.session_replay.*`" assertions (including the post-`buffer→full` and `mode: 'off'` cases) belong in `BrowserSessionSpanProcessor.test.ts` (already exists) with a fake `Span`. Split Task 5: configure wiring + cleanup ordering → `index.test.ts`; attribute stamping → the processor test.

### 6. (Medium) Replay records the telemetry exporters in steady state, not just at shutdown

The plan only guards the shutdown slice ("exporter requests not captured during SDK shutdown", plan 481-483). But `captureNetwork` wraps `window.fetch` (`capture.ts:95-138`), and the OTLP trace/metric exporters POST through `window.fetch`, so **every export is recorded as a replay network event for the whole session**. `redactUrlPatterns` only rewrites the URL string in the event — it does not suppress it. The integration should default `redactUrlPatterns` to the configured `traceUrl`/`metricUrl`/`replayUrl`, and ideally coordinate with OTel fetch instrumentation `ignoreUrls`.

Replay's _own_ uploads are already safe — `resolveConfig` binds `fetchImpl = fetch.bind(globalThis)` (`index.ts:159`) before `captureNetwork` wraps — but exporter traffic is not.

### 8. (Medium) Option-drift hazard in the mirrored option type

`BrowserSessionReplayOptions` hand-mirrors the entire `SessionReplayConfig` surface "without exporting a hard type dependency" (plan 188-228). Keeping the peer truly optional for TS users is a defensible reason, but it creates silent drift: a new replay option won't be forwarded unless someone updates both the local type and the passthrough in `startBrowserSessionReplay`. Add a guard — e.g. a dev/test-only type assertion that the local options are assignable to the peer's `SessionReplayConfig` (compiled where the peer is present).

### 9. (Low–Med) No changeset task

Both packages take package-visible changes (replay gains `mode`; browser gains `sessionReplay`), so each needs `pnpm run changeset-add` per CLAUDE.md. Neither the task list nor the validation section mentions it.

### 12. (Low) Peer range vs. unpublished package

The plan deliberately doesn't publish (plan 25) yet declares an optional peer dependency (Task 1). The replay package is `version: 0.0.0`. A `^0.1.0`-style range matches nothing; locally only `workspace:*` works. Specify the pre-publish handling (workspace protocol for dev; published range deferred to the release PRP) so the implementer doesn't invent a breaking range.

---

## Risky ideas

### 3. (High) The plan commits to an API it simultaneously flags as the #1 risk

The plan rates optional-peer bundling as "the largest risk … Validate this before accepting the API shape" (plan 522-524), but then fully specifies the API with **no loader seam** and bakes a static `import('@pydantic/logfire-session-replay')` into the helper (Task 3). A bare-specifier dynamic import of an _uninstalled_ package commonly trips Vite/Rollup/webpack resolution; if validation fails, the fix changes the public API — a breaking change once shipped.

Decide the bundler-safe shape **before** implementation. A `load` callback removes any static reference to the peer, so no-replay apps never resolve it:

```ts
sessionReplay?: false | (BrowserSessionReplayOptions & {
  load?: () => Promise<{ startSessionReplay: (c: SessionReplayConfig) => SessionReplay }>
})
```

If the static import is kept, at minimum prototype the no-replay app build in Task 7 _before_ freezing the type in Success Criteria.

### 7. (Medium) `getSessionId: () => browserSessionManager.touch().id` sits on the recording hot path

The replay calls `getSessionId(true)` on **every emitted rrweb event** (`index.ts:68-73`) to detect rotation. Wiring that to `touch()` means each event runs `sessionStorage.getItem` + `JSON.parse` + `setItem` + `JSON.stringify` (`browserSession.ts:135-141, 185-215`). rrweb emits hundreds/sec during active interaction, so this puts synchronous storage I/O on the capture hot path, and it means replay activity continuously `touch`es the RUM session — a tab recording mutations/animations would **never idle-timeout**. Mitigate with a cheap cached accessor (in-memory id the manager updates on its own cadence), or pass read-only `getSession().id` and let span starts own activity touching. At minimum, acknowledge the coupling.

---

## What's sound (so the critical points stand out)

- **Central decision verified correct:** not passing `getTraceContext` leaves `traceTimer` undefined (`index.ts:84`), so `meta.traceIds` stays empty — exactly the "no incomplete trace set masquerading as complete" outcome the plan wants.
- **Optional peer (not `dependencies`) is right** — the web-vitals contrast (it _is_ a direct dep, `package.json:64`) confirms the intended pattern.
- **Cleanup-before-unregister ordering is correct:** both replay and OTel wrap `window.fetch`; unwrapping in reverse install order (replay first) is the safe choice.
- **Best-effort startup + memoized cleanup + idempotent `stop()`** match existing patterns (`index.ts:422-477`) and the replay's internal `stopPromise` memoization (`index.ts:136`). "Stop exactly once" is already guaranteed by the outer `cleanupPromise ??=`.
- **`sessionReplay` implying `rum.session`** mirrors the established `resolveBrowserSessionOptions` precedent (`index.ts:224-237`), including the throw-on-`false` shape.
- The `index.test.ts` harness uses `vi.hoisted` + `vi.mock`, so mocking a local `./sessionReplay` helper is a natural extension — Task 5's mocking approach is feasible.

---

## Recommended edits to the plan

1. Rewrite the `mode` design: live getter on the handle (reads `transport.getMode()`); processor reads it at `onStart`; delete the cached `setActive(mode)` one-shot (or add a transition callback that updates `replayState`).
2. Add an explicit task: **MODIFY `BrowserSessionSpanProcessor`** (constructor + `onStart` stamping), with assertions in `BrowserSessionSpanProcessor.test.ts`.
3. Remove `sessionIdleTimeoutMs`/`maxSessionDurationMs` from `BrowserSessionReplayOptions` (or mark them ignored under SDK-owned sessions).
4. Decide the bundler-safe API now — prefer a `load` callback over a static bare-specifier import.
5. Default `redactUrlPatterns` to the telemetry endpoints; address steady-state self-recording, not just shutdown.
6. Add a cached/throttled session-id accessor for the replay hot path.
7. Fix validation: `--filter browser` (+ proxy process), drop `vp check <paths>`, add changesets for both packages.
8. Add an anti-drift guard for the mirrored option type, and specify the pre-publish peer-range handling.

---

## Re-check — revised plan (675 lines, same branch/commit)

The plan was revised after this report. All 12 findings are addressed; fixes verified against code where the claim matters.

- `redactUrl` confirmed to only rewrite (`${origin}${pathname}`) and still emit the network event (`capture.ts:351-363`, emit at `:110/:123/:191`) — so the revision's new `ignoreUrlPatterns` suppression is genuinely distinct from redaction, not redundant.
- `capture.test.ts` exists, so Task 5's new target is valid.

| #   | Status  | Note                                                                                                                 |
| --- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | Fixed   | Handle `mode` is now a live getter (`transport.getMode()`); `BrowserSessionReplayState.getState()` reads it per span |
| 2   | Fixed   | Explicit `BrowserSessionSpanProcessor` edit in Task 4                                                                |
| 3   | Fixed   | Required `load` IoC callback; no static import in the browser package                                                |
| 4   | Fixed   | Dead timeout options removed + documented                                                                            |
| 5   | Fixed   | Span assertions moved to `BrowserSessionSpanProcessor.test.ts`                                                       |
| 6   | Fixed+  | New `ignoreUrlPatterns` suppression in the standalone package, default-merged with trace/metric/replay URLs          |
| 7   | Partial | See R1                                                                                                               |
| 8   | Fixed   | Dev/test assignability assertion                                                                                     |
| 9   | Fixed   | Task 8 changesets + `pnpm run check`                                                                                 |
| 10  | Fixed   | `--filter browser` dev+proxy; dropped `vp check <paths>`                                                             |
| 11  | Fixed   | Handoff-doc caveat added                                                                                             |
| 12  | Fixed   | Workspace protocol now; semver deferred to publish                                                                   |

### Remaining

- **R1 (Medium).** Task 3 passes `getSessionId` via "a cheap read-only/cached accessor," but `BrowserSessionManager` has no such method: `touch()` writes + bumps activity (correctly rejected), and `getSession()` does per-call storage I/O and **creates/persists a new session on expiry** (`browserSession.ts:172-179`) — letting replay drive rotation, which contradicts gotcha 192-195. Add a zero-I/O `peekId()` returning in-memory `memorySession?.id` (refreshed by the span processor's `touch()`), and pass that to replay.
- **R2 (Low).** `load` is now required but the Task 6 README/example doesn't show `load: () => import('@pydantic/logfire-session-replay')`; documented config won't type-check without it.
- **R3 (Low).** The revised `SessionReplay` requires `readonly mode`, so the `NOOP` literal (`index.ts:29-34`) needs `mode: 'off'` — Task 1 specifies the getter for the active handle only.
- **R4 (Low, optional).** Make standalone `recording` a getter that returns false after `stop()`, so `getState()` is robust even if a caller forgets to pair `clear()` with `stop()`.

**Revised verdict:** only R1 is substantive (an accessor the plan assumes but that doesn't exist with correct semantics); the rest are one-line cleanups. With R1 specified, confidence moves from 7/10 toward 8/10.
