# Browser RUM Stable Release Readiness

## Goal

Produce a stable-ready browser RUM and session replay release candidate for:

- `@pydantic/logfire-browser@0.17.0`
- `@pydantic/logfire-session-replay@0.1.0`

The implementation must harden replay and instrumentation lifecycle behavior, settle the public stable contracts that still describe alpha-only behavior, add release-note ownership for those changes, and leave the branch in Changesets `exit` mode. Merging and publishing through the subsequent `Version Packages` workflow is a separately authorized release runbook, not part of implementation verification for this PRP.

## Why

- The alpha proved the package shape and Platform integration, but replay singleton ownership, partial startup failures, session rotation, lifecycle flushes, and retry paths still have correctness gaps that should not become the stable `0.1.0` contract.
- Public browser documentation still describes temporary alpha URL aliases and overstates which errors promote buffered replay.
- The current Changesets peer dependency topology proposes `@pydantic/logfire-browser@1.0.0` unless the replay peer range and peer-dependent policy are corrected.
- Merging `.changeset/pre.json` in `pre` mode would not create the intended stable release plan because all current changesets are already recorded as consumed by the alpha.

## Success Criteria

- [x] The page has one `globalThis`-scoped replay-controller lease across duplicate module instances: it is held through sampled-off sessions and later activation failures, a second `startSessionReplay()` fails without disturbing the owner, and a new controller can start only after owner stop or initial construction rollback.
- [x] Console/fetch/XHR/history cleanup never overwrites a later third-party patch, and inactive Logfire wrappers do not emit or become active again.
- [x] Replay startup is transactional: any synchronous setup failure removes all recorder state, timers, listeners, and patches installed earlier in that attempt before the error escapes.
- [x] If rrweb returns no stop function after swallowing an internal startup error, startup fails and rolls back instead of exposing a handle whose `recording` property is falsely `true`.
- [x] Replay sampling is resolved and persisted per browser session id, including rotations from `full`/`buffer` to `off`, from `off` to an active mode, and error promotion that applies only to the current session.
- [x] Replay mode and `recording` remain truthful after a session rotation, and browser spans emit replay-active attributes only while the current session is actually recording.
- [x] `pagehide` requests a keepalive flush regardless of the document's current visibility state; `visibilitychange` still flushes only when hidden.
- [x] A transient `web-vitals/attribution` startup failure is retryable, while observer registration options are explicitly first-successful-start/page-lifetime settings and tracer/metric sinks remain replaceable.
- [x] User instrumentation factory/registration failures do not leave `configure()` half-started or prevent the rest of browser telemetry from being configured.
- [x] Consumer `onError` callbacks cannot turn handled optional-feature or transport failures into application failures or unhandled promise rejections.
- [x] Stable browser spans use `logfire.page.url.full` and `logfire.page.url.path` for page context without the alpha-only `url.full` / `url.path` aliases.
- [x] Replay documentation states that buffered promotion is triggered by uncaught `window.error` and `unhandledrejection`, not by every `console.error` or caught/reported error.
- [x] A new patch Changeset owns the stable hardening and contract cleanup, and Changesets in exit mode reports exactly browser `0.17.0` and replay `0.1.0`; it does not report browser `1.0.0` or another publishable package.
- [x] The branch-specific alpha workflow is removed before the rebased branch is force-pushed, and the existing general npm token helper is retained.
- [x] The full repository check passes and every consumer scenario below has outside-in verification evidence.

## Consumer Contract

### Consumer and Public Boundary

- **Consumers**: browser SDK integrators, standalone session replay integrators, applications using OpenTelemetry browser instrumentations, Logfire Platform as a downstream telemetry consumer, and release operators maintaining npm packages.
- **Public or supported boundary**: `logfire.configure(...)`, `startSessionReplay(...)`, the returned async cleanup/replay handles, emitted span attributes and replay uploads, package documentation, npm package versions/dist-tags, and the repository's Changesets release workflow.
- **Entry point and prerequisites**: a browser-like runtime with the documented package configuration; replay requires a replay endpoint and optional lazy package loader; release operation requires the repository npm environment and the normal protected-branch workflow.
- **Current observable behavior**: alpha packages `@pydantic/logfire-browser@0.17.0-alpha.2` and `@pydantic/logfire-session-replay@0.1.0-alpha.1` are published. Runtime cleanup and failure paths have the gaps listed in the research summary. `.changeset/pre.json` remains in `pre` mode.
- **Observable promise**: applications can configure browser telemetry, refresh supported page-lifetime optional-feature sinks, rotate replay sessions, recover from optional-feature failures, and shut down without leaked or stale instrumentation; emitted telemetry follows the documented stable attribute/sampling contract; release operators receive a deterministic stable version plan.
- **Must remain compatible with**: existing documented `configure()` and `startSessionReplay()` call shapes, proxy-first replay transport, lazy optional peer loading, rrweb event integrity, OpenTelemetry browser SDK behavior, and the Platform query path that already prefers `logfire.page.url.*` with legacy fallbacks.
- **Not claimed**: full cleanup followed by a second `configure()` in the same OpenTelemetry global realm, automatic capture of every caught/reported application error, guaranteed unload delivery with an individually oversized rrweb FullSnapshot or a still-pending asynchronous credential callback, removal of already-published alpha package versions, or completion of the separate Platform rollout PR.

### Acceptance Scenarios

| ID     | Given                                                                                              | When                                                                                    | Then                                                                                                                                                                                         | Evidence surface                                                                                             | Required evidence                                                                                    |
| ------ | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `CX-1` | One standalone replay controller owns the page lease, whether its current session is active or off | A second replay start is attempted, then the owner stops and a third start is attempted | The second start reports a deterministic active-controller error without changing the first replay; after stop, the third start succeeds; cleanup never overwrites a later third-party patch | Vitest jsdom exercise through `startSessionReplay()` plus real patched globals                               | DIRECT REQUIRED                                                                                      |
| `CX-2` | Replay setup has already started recording and registered some resources                           | A later capture setup step throws synchronously                                         | `startSessionReplay()` reports failure and the page has no leaked recorder, timer, listener, or Logfire global patch from the failed attempt; a later clean start succeeds                   | Vitest jsdom exercise with a throwing capture/global assignment followed by a second public start            | DIRECT REQUIRED                                                                                      |
| `CX-3` | A replay handle observes an external or internal session id that later rotates                     | The next session resolves to a different sampling decision                              | Uploads and replay-active span attributes use only the current session id/mode; an `off` session records nothing and a later sampled session can activate without a page reload              | Public `startSessionReplay()` and `logfire.configure()` tests with fake time/id source and deterministic RNG | DIRECT REQUIRED                                                                                      |
| `CX-4` | A full-mode replay has buffered events while the document is still visible                         | The browser dispatches `pagehide`                                                       | A final replay request is attempted with `keepalive: true`                                                                                                                                   | Vitest jsdom lifecycle event through the public replay handle                                                | DIRECT REQUIRED                                                                                      |
| `CX-5` | Web Vitals lazy loading fails transiently                                                          | The application configures Web Vitals again after the dependency becomes available      | Observers register on the retry and subsequent metrics/spans use the latest sinks; attempting to change page-lifetime observer options is diagnosed and does not create duplicate observers  | Browser package test through `configure()`/startup with controlled dynamic-import mock                       | PROXY ACCEPTABLE — jsdom cannot reproduce a real browser chunk loader but exercises the SDK contract |
| `CX-6` | A configured instrumentation factory, registration, or consumer `onError` callback throws          | The application calls `configure()` or an optional replay failure occurs                | Core browser telemetry remains configured, failures are diagnosed, cleanup remains available, and no unhandled rejection escapes to the host application                                     | Browser package tests through public `configure()` with throwing fakes and rejection tracking                | PROXY ACCEPTABLE — OpenTelemetry fakes exercise the supported integration boundary                   |
| `CX-7` | Browser session URL attributes are enabled with default, sanitized, and disabled configurations    | A consumer configures the public browser SDK and starts a span                          | Exported page context uses `logfire.page.url.full/path` only, with documented default query/fragment behavior and no legacy aliases                                                          | Public `configure()` test with an in-memory exporter                                                         | DIRECT REQUIRED                                                                                      |
| `CX-8` | The stable hardening Changeset exists and Changesets is in exit mode                               | A release operator runs Changesets status                                               | The local release plan is exactly browser `0.17.0` and replay `0.1.0`, with no browser `1.0.0` or other publishable package                                                                  | Local Changesets status and detached version simulation                                                      | DIRECT REQUIRED                                                                                      |

## Research Summary

### Vetted Repository Findings

- `packages/logfire-session-replay/src/capture.ts:20-55,75-104,109-167,170-270` — capture functions store a global method and restore it unconditionally, so cleanup can overwrite a later third-party patch or restore inactive Logfire predecessors. — **PRP impact**: introduce ownership-aware patch cleanup and direct helper tests.
- `node_modules/.pnpm/rrweb@2.1.0/node_modules/rrweb/dist/rrweb.js:14207-14210,14676-14679` — rrweb uses page-global recording/emit/full-snapshot state; a second `record()` overwrites singleton state and either stop disables global recording. — **PRP impact**: enforce one page-level Logfire replay controller/lease rather than promising concurrent recorders.
- `packages/logfire-session-replay/src/index.ts:66-135` — recording, timers, and listeners start before all optional capture modules succeed, and cleanup exists only on the returned handle. — **PRP impact**: make setup transactional and prove a clean second start after failure.
- `packages/logfire-session-replay/src/recorder.ts:45-75` and rrweb's `record()` implementation — rrweb catches some startup errors and returns `undefined`, while the wrapper currently returns a recorder handle and the public controller reports `recording: true`. — **PRP impact**: treat a missing rrweb stop function as startup failure and include it in transactional rollback.
- `packages/logfire-session-replay/src/index.ts:58-72,96-103` and `src/transport.ts:99-111` — sampling is resolved for the initial id; rotation updates id/sequence but not mode, and error promotion mutates transport mode for later sessions. An initial `off` returns a permanent no-op. — **PRP impact**: introduce a session-aware runtime/controller with dynamic truthful getters.
- `packages/logfire-session-replay/src/session.ts:23-50` — the internal session manager can create a new id from `getSession()` when idle/max duration expires. — **PRP impact**: session monitoring can support internal and externally supplied ids without changing the public callback shape.
- `packages/logfire-session-replay/src/index.ts:108-119` — `visibilitychange` and `pagehide` share a handler gated by hidden visibility. — **PRP impact**: split the event handlers and directly test visible-state `pagehide`.
- `packages/logfire-browser/src/sessionReplay.ts:87-107,232-252` — replay state reads runtime getters dynamically, but the runtime is stored only when initially active. — **PRP impact**: retain a successfully created dynamic runtime even when its initial sampling mode is off, while keeping span attributes truthful.
- `packages/logfire-browser/src/webVitals.ts:228-243` — startup errors are swallowed into a fulfilled memoized promise; later starts cannot retry. Report options are captured on first registration while tracer/recorder are mutable. — **PRP impact**: reset/rethrow failed startup and codify first-successful-start observer options.
- `packages/logfire-browser/src/index.ts:283-355,439-454` — user factories run after provider registration, which is required by the alpha lifecycle design, but a synchronous throw can escape after global registration. — **PRP impact**: isolate and diagnose factory/registration failures instead of leaving `configure()` half-started.
- `packages/logfire-browser/src/sessionReplay.ts:160-167`, `packages/logfire-session-replay/src/index.ts:263-271`, and `src/transport.ts:129-150` — consumer error callbacks are invoked without the defensive guard already used by `capture.ts:safeEmit`. — **PRP impact**: centralize safe callback reporting and test throwing callbacks.
- `packages/logfire-browser/src/BrowserSessionSpanProcessor.ts:8-15,70-82` — page context is duplicated into explicit Logfire keys and alpha compatibility `url.*` keys. `plans/020-browser-rum-replay-lifecycle.md` records the aliases as alpha-only. — **PRP impact**: remove aliases for stable and update tests/docs.
- `packages/logfire-browser/README.md:73-82` and `docs/packages/browser.md:71-90` — documentation still says “During the alpha” and describes the default URL as sanitized even though `browserSession.ts:151-163` defaults to `url.href`. — **PRP impact**: document the stable keys and query/fragment privacy behavior precisely.
- `packages/logfire-session-replay/README.md:107-113` — “if an error occurs” is broader than the implemented `window.error` and `unhandledrejection` promotion hooks. — **PRP impact**: narrow the documented promise; automatic caught/reportError integration remains out of scope.
- `.changeset/pre.json:2-28` — prerelease mode is still `pre`, and all six alpha changeset ids are recorded as consumed. Those entries describe the alpha feature work, not this stable hardening. — **PRP impact**: add a new patch Changeset for browser and replay, use `changeset pre exit`, and do not manually delete existing changesets on the feature branch.
- `packages/logfire-browser/package.json:65-75` and `.changeset/config.json:1-12` — the optional replay peer uses `workspace:*` and default Changesets peer-dependent behavior. — **PRP impact**: use `workspace:^` and `onlyUpdatePeerDependentsWhenOutOfRange` so replay `0.1.0` does not force browser `1.0.0`.
- `.github/workflows/alpha-release.yml:1-71` — publication is hardcoded to the alpha branch and manual dispatch can move replay `latest` to an alpha. — **PRP impact**: delete this one-off workflow before pushing stable-ready history.
- `.github/workflows/main.yml:38-90` — the normal main workflow uses `changesets/action`, then creates tags and GitHub releases for published packages. — **PRP impact**: preserve the normal two-stage feature PR -> Version Packages PR -> publish flow.
- `AGENTS.md:9-17` — the canonical package layout does not list the new replay package. — **PRP impact**: update repository guidance.

### External Constraints

- [pydantic/platform#25595](https://github.com/pydantic/platform/pull/25595) — inspected 2026-07-13; the Platform change prefers `logfire.page.url.*` with legacy fallbacks and currently pins the alpha packages. It remains open/conflicting. — **Impact**: explicit Logfire page keys are the stable downstream contract; updating/merging the Platform PR is a separate post-publication operation.
- npm registry state inspected 2026-07-13 — browser `latest=0.16.4`, `alpha=0.17.0-alpha.2`; replay `latest=alpha=0.1.0-alpha.1`. — **Impact**: stable publication must move `latest` to `0.17.0` and `0.1.0`; retaining or removing historical `alpha` dist-tags is not required by this PRP.
- `@changesets/cli` 2.30.0 from the installed workspace — a detached simulation of `pre exit` + `version` produced browser `1.0.0` as-is, and browser `0.17.0` after combining `workspace:^` with `onlyUpdatePeerDependentsWhenOutOfRange`. — **Impact**: both changes are load-bearing release preparation.

### Settled Decisions and Rejected Alternatives

- **Decision**: keep one bounded executable PRP covering runtime hardening, stable contract cleanup, release-note ownership, and prerelease exit. Treat force-push, both PR merges, npm publication, downstream rollout, and branch deletion as a non-executable checkpointed runbook. — **Rationale**: local changes share one testable consumer promise, while irreversible rollout stages require distinct authorization and validation loops.
- **Decision**: implement true per-session sampling within a long-lived replay controller. An off session keeps only a lightweight session monitor; it must not install rrweb or capture globals. On rotation, synchronously detach and stop the old recorder/captures, expose `mode: 'off'` and `recording: false`, then await the old full-session flush before activating the next session. Report an old flush failure but continue activation; drop late old-runtime events and unpromoted buffer data. `flush()` waits for the serialized transition before flushing the current runtime, while `stop()` marks the controller stopped immediately, waits for in-flight teardown, and prevents pending activation. — **Rationale**: this defines the race boundary needed to prevent cross-session labelling while preserving eventual activation after transport failure.
- **Decision**: the returned replay handle exposes dynamic `mode` and `recording` getters; the browser replay state retains that runtime even when the initial mode is off. — **Rationale**: span attributes can then follow later session transitions without adding a new public callback API.
- **Decision**: enforce one `globalThis`-scoped `startSessionReplay()` controller lease, keyed with `Symbol.for(...)` so duplicate package instances in the same realm coordinate. Acquire it before initial sampling and hold it through active, transitioning, sampled-off, and later activation-failed states. Initial controller construction failure and `stop()` release it; a later per-session activation failure leaves the controller off but retains it. — **Rationale**: rrweb 2.1.0 is page-global, and an off controller can activate later. Multiplexing capture wrappers or using a module-local flag cannot make duplicate controllers correct.
- **Decision**: make Logfire function patches ownership-aware even with the replay lease. Cleanup restores only when it still owns the current function, inactive wrappers pass through without emitting, and partial multi-method installation rolls back. — **Rationale**: third-party instrumentation can still install after Logfire and must not be overwritten.
- **Decision**: a missing stop callback from rrweb is a failed recorder start, not a stoppable successful recorder. — **Rationale**: rrweb returns `undefined` after swallowing some initialization errors; accepting that value would make the public `recording` state untruthful and prevent reliable cleanup.
- **Decision**: a failed initial active-runtime setup rolls back synchronously and rethrows; a later session-transition setup failure is safely reported, leaves that session off, and may try again only after a new session id. — **Rationale**: preserves the synchronous public API while avoiding leaks and retry loops.
- **Decision**: user instrumentation factories remain deferred until the provider is registered, but each factory/registration group is isolated. A failure is diagnosed, any partially enabled group is disabled, and core configuration continues. — **Rationale**: preserves the lifecycle-safe factory contract without leaving callers unable to clean up.
- **Decision**: the first successful Web Vitals startup fixes page-lifetime observer options (`reportAllChanges`, `generateTarget`, `includeProcessedEventEntries`); later calls may update tracer and metric recorder only. A transient failed first start is retryable. — **Rationale**: `web-vitals` observers cannot be unregistered safely without duplicate callbacks.
- **Decision**: remove the `url.full`/`url.path` page aliases for stable and document only `logfire.page.url.full/path`; keep the current default of full `url.href` and explain how to sanitize it. — **Rationale**: the alpha plan explicitly marked the aliases temporary, and the downstream Platform query already prefers the explicit keys.
- **Decision**: error-buffer promotion means uncaught `window.error` and `unhandledrejection`. — **Rejected**: treating `console.error`, `logfire.reportError`, or every caught exception as automatic promotion in this PRP; that requires a broader cross-package error API decision.
- **Decision**: add a new patch Changeset for both public packages, then follow the normal two-PR Changesets process. The feature PR commits `pre exit` state but not generated stable versions; the generated Version Packages PR is reviewed separately before publication. — **Rejected**: relying only on alpha changesets for later hardening or manually versioning/publishing stable packages from the feature branch.
- **Decision**: delete `.github/workflows/alpha-release.yml`, retain `scripts/create-npm-token.sh`, and leave historical npm alpha versions/dist-tags unchanged unless an operator separately chooses to retire the tag.

### Spike Evidence

- A disposable detached-worktree simulation added the planned patch Changeset, changed the replay peer to `workspace:^`, enabled out-of-range-only peer updates, exited pre mode, and ran both `changeset status` and `changeset version`. It produced public versions browser `0.17.0` and replay `0.1.0`.
- The same simulation showed the expected private-only normalization of `examples/nextjs-client-side-instrumentation` to `0.1.16` plus the unwanted versionless `examples/nextjs` artifact. A trial with `privatePackages: false` expanded churn across more private examples, so this PRP rejects that config change and keeps release-PR cleanup targeted.
- The simulations did not publish packages or mutate external state.

### Validation Baseline

| Command                                                                                                | Status                 | Observed or expected result                                                                                                                |
| ------------------------------------------------------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `vp run @pydantic/logfire-session-replay#test`                                                         | Verified               | 8 test files and 73 tests passed during PRP research.                                                                                      |
| `vp run @pydantic/logfire-browser#test`                                                                | Verified               | 6 test files and 83 tests passed during PRP research.                                                                                      |
| `node_modules/.bin/changeset status --output=...` in current `pre` mode                                | Baseline failing       | Reports that packages changed but no changesets were found because the alpha changesets are recorded as consumed.                          |
| Detached `changeset pre exit && changeset version` simulation, current config                          | Verified               | Proposed browser `1.0.0`, replay `0.1.0`, and unwanted private `examples/nextjs` `version: null` churn.                                    |
| Detached simulation with new patch Changeset, replay `workspace:^`, and out-of-range-only peer updates | Verified               | Proposed browser `0.17.0` and replay `0.1.0`; only private prerelease cleanup remained, including the unwanted `examples/nextjs` artifact. |
| `pnpm run check`                                                                                       | Discovered but not run | Required final integrated gate after implementation.                                                                                       |
| `vp run @pydantic/logfire-browser#typecheck`                                                           | Discovered but not run | Required public type gate.                                                                                                                 |

### Research Coverage

- **Depth**: Deep
- **Inspected**: session replay startup/capture/sampling/session/transport and tests; browser configure/session replay/span processor/Web Vitals and tests; public README/docs/examples; Changesets configuration/state; alpha and normal release workflows; package manifests; npm dist-tags; closed SDK alpha PR feedback; linked Platform integration PR; git history around lifecycle changes.
- **Not inspected**: Platform implementation beyond the linked PR diff; npm organization policy outside the repository workflow; browser-specific unload behavior beyond the jsdom contract; replay backend ingest internals because the wire envelope is unchanged.
- **Research confidence**: HIGH — runtime findings were reproduced by concrete execution traces and independently reviewed; versioning was empirically simulated with the installed Changesets version.

## Execution Contract

- **Planned at commit**: `09568d3`
- **Planning baseline**: dirty only because `plans/020-browser-rum-replay-lifecycle.md` is a pre-existing untracked user file. Preserve it exactly; do not stage, rewrite, or delete it as part of this PRP.

### Expected Changes

- `packages/logfire-session-replay/src/capture.ts` and `capture.test.ts` — ownership-aware patch cleanup and rollback coverage.
- `packages/logfire-session-replay/src/index.ts`, `index.test.ts`, and possibly a new internal runtime/controller module — transactional active-runtime setup, per-session sampling transitions, dynamic handle state, page lifecycle flushing, safe error reporting.
- `packages/logfire-session-replay/src/recorder.ts` and `recorder.test.ts` — reject rrweb's missing stop callback as a failed start.
- `packages/logfire-session-replay/src/transport.ts` and tests — explicit mode/session transition support if the controller cannot own it entirely.
- `packages/logfire-session-replay/README.md` and exported type comments — exact sampling/error/lifecycle contract.
- `packages/logfire-browser/src/sessionReplay.ts` and tests — dynamic replay state retention and safe callback handling.
- `packages/logfire-browser/src/index.ts` and tests — isolated instrumentation factory/registration failures with usable cleanup.
- `packages/logfire-browser/src/webVitals.ts` and tests — retryable startup and page-lifetime option contract.
- `packages/logfire-browser/src/BrowserSessionSpanProcessor.ts` and tests — remove alpha URL aliases.
- `packages/logfire-browser/README.md` and `docs/packages/browser.md` — stable page URL, replay, and Web Vitals lifecycle documentation.
- `packages/logfire-browser/package.json` — replay peer range suitable for stable internal dependency versioning.
- A new `.changeset/*.md`, plus `.changeset/config.json` and `.changeset/pre.json` — patch release note ownership, peer-dependent policy, and prerelease exit.
- `.github/workflows/alpha-release.yml` — remove one-off alpha publisher.
- `AGENTS.md` — document the new package layout.
- Existing changeset files — remain until the generated Version Packages PR consumes them.

### Explicitly Out of Scope

- Changing the replay chunk envelope, backend ingest endpoint, gzip format, retry policy, or inability to split one oversized rrweb event safely for unload.
- Adding automatic caught-error, `console.error`, or `logfire.reportError` promotion to session replay.
- Completing or modifying the Platform repository PR; only its dependency/contract is recorded here.
- Publishing from the feature branch, bypassing the Changesets action, deleting published alpha versions, or silently removing npm alpha dist-tags.
- Executing the post-implementation force-push, PR merges, npm publication, Platform update, or branch deletion without passing their separate authorization checkpoints.
- Refactoring unrelated OpenTelemetry packages or normal release automation.
- Committing the pre-existing `plans/020-browser-rum-replay-lifecycle.md` file.

### Scope Expansion Rule

Additional files may change when necessary to implement an internal session-aware replay runtime or shared patch helper without changing public intent. Record each added file and rationale in Execution Notes. Pause if implementation requires a new public callback/event API, changes replay wire data, changes session timeout defaults, or alters repository-wide release policy beyond peer-dependent version calculation.

### Pause and Reassess If

- True per-session resampling cannot be implemented without changing the public `SessionReplay` or `BrowserSessionReplayOptions` shape.
- An OpenTelemetry limitation makes it impossible to contain a failed instrumentation registration without disabling unrelated global providers.
- Removing `url.*` aliases would break a current supported consumer that has not migrated to `logfire.page.url.*`.
- Changesets status still proposes browser `1.0.0`, a different replay version, or additional publishable packages after the planned peer/config changes.
- The implementation must touch the pre-existing untracked plan or unrelated user changes.
- External merge, tag, or npm publication is required before local/PR verification is complete; obtain explicit user authorization before those operations.

## Context

### Key Files

- `plans/020-browser-rum-replay-lifecycle.md` — prior alpha lifecycle intent and temporary compatibility decisions; read-only input for this PRP.
- `packages/logfire-session-replay/src/index.ts` — public replay entry point and current lifecycle owner.
- `packages/logfire-session-replay/src/capture.ts` — global console/network/navigation patching.
- `packages/logfire-session-replay/src/session.ts` — session expiry and rotation behavior.
- `packages/logfire-session-replay/src/transport.ts` — session id, mode, buffering, flushing, and sequencing.
- `packages/logfire-session-replay/src/recorder.ts` — rrweb start/stop/full-snapshot boundary.
- `packages/logfire-browser/src/index.ts` — browser provider registration, optional feature startup, and cleanup ordering.
- `packages/logfire-browser/src/sessionReplay.ts` — optional peer integration and replay span state.
- `packages/logfire-browser/src/webVitals.ts` — page-lifetime observer singleton and mutable sinks.
- `packages/logfire-browser/src/BrowserSessionSpanProcessor.ts` — session/replay/page attributes on spans.
- `.changeset/pre.json`, `.changeset/config.json`, `.github/workflows/main.yml` — stable version calculation and publication path.

### External References

- [Platform PR #25595](https://github.com/pydantic/platform/pull/25595) — downstream alpha consumer, explicit page URL preference, and remaining rollout coordination.
- [Changesets prereleases documentation](https://github.com/changesets/changesets/blob/main/docs/prereleases.md) — prerelease exit model; repository behavior is additionally pinned by the installed 2.30.0 simulation.

### Gotchas

- The replay controller lease must live on `globalThis` under `Symbol.for(...)`, not in module-local state. Acquire it before initial sampling, retain it through off sessions and later activation failures, and release it only on owner stop or initial controller-construction rollback.
- rrweb may catch an internal initialization error and return no stop callback. Do not mark the runtime active unless `startRecording()` has a real cleanup function.
- Checking `currentGlobal === ownedWrapper` protects later third-party owners, but owned wrappers must also become inert immediately on stop so a third-party chain cannot continue emitting through a stopped Logfire wrapper.
- Multi-method capture setup must be transactional internally. If patching the third console/XHR/history method throws, the caller does not yet have a stop handle for the first methods.
- An initial `off` sampling decision cannot return the current constant no-op if later sessions must be resampled. It needs a lightweight controller/monitor with dynamic getters and no rrweb/global capture until active.
- Session transitions must detach the old runtime and make public state inactive before awaiting its flush. Flush failure is reported but does not strand the next session; manual flush waits for the transition, and stop prevents pending activation. Error promotion persists `full` only for the current id.
- `pagehide` can occur before visibility becomes hidden; it must not share the hidden-state guard.
- `web-vitals` callbacks cannot be unregistered through the current API. Do not retry after a successful registration or create duplicate observers; retry only failed startup.
- Factories are intentionally lazy because some browser instrumentation needs the registered provider. Preserve that ordering while isolating failures.
- `workspace:*` represents the current exact version to Changesets. For a stable `0.1.0` peer transition, `workspace:^` and the out-of-range-only peer policy are both required.
- `changeset pre exit` changes only prerelease state. The generated stable package versions/changelogs belong in the subsequent Version Packages PR.
- Changesets 2.30.0 may generate `examples/nextjs/package.json` with `"version": null`; remove that artifact from the generated release PR rather than normalizing it into this feature.

## Implementation Blueprint

### Data Models

No wire schema changes are required. Introduce internal lifecycle state only:

- An ownership record for each patched function, containing its wrapper, predecessor, and active/stopped state so stopped wrappers pass through and cleanup never overwrites an unrelated current owner.
- A `globalThis` controller lease keyed by `Symbol.for(...)`, plus controller state containing current session id, resolved sampling mode, optional active recorder/capture/transport runtime, serialized transition promise, monitor timer, and stopped flag.
- The public `SessionReplay` handle continues exposing the existing methods/properties, implemented as getters/delegates over controller state.

### Tasks

```yaml
Task 1: Characterize page-level replay ownership and patch cleanup
  MODIFY packages/logfire-session-replay/src/capture.test.ts:
    - Install a third-party wrapper after Logfire for console, fetch, XHR open/send, and history push/replace; prove Logfire stop does not overwrite it and stopped wrappers do not emit.
    - Add partial multi-method setup failure coverage.
  MODIFY packages/logfire-session-replay/src/index.test.ts:
    - Start replay A, assert replay B fails without disturbing A, stop A, then prove replay C can start and stop normally.
    - Use isolated/reset module imports sharing one jsdom global to prove the lease coordinates duplicate package instances rather than only one module's local state.
    - Repeat the second-start rejection while A is initially sampled off and after A has experienced a later per-session activation failure.
    - Assert failed initial controller setup releases the page lease, while later active-runtime failure retains it until owner stop.
  MODIFY packages/logfire-session-replay/src/recorder.test.ts:
    - Assert rrweb returning no stop callback is a startup error rather than a successful recorder handle.
  ENABLES: CX-1, CX-2
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-session-replay#test
    - EXPECTED: New tests fail against the current lack of lease and unconditional restore behavior.

Task 2: Implement the replay lease and ownership-aware transactional patches
  MODIFY packages/logfire-session-replay/src/index.ts:
    - Acquire a non-enumerable, configurable `globalThis` controller lease keyed by `Symbol.for(...)` before initial sampling or any rrweb/capture setup so duplicate module instances in the same realm coordinate.
    - Hold the lease while the controller is active, transitioning, sampled off, or recovering from a later activation failure; reject a second live controller without modifying the owner.
    - Release the lease exactly once after normal stop or failed initial controller construction, but not after a later per-session active-runtime failure.
  MODIFY packages/logfire-session-replay/src/recorder.ts:
    - Throw a deterministic startup error when rrweb returns no stop callback so the caller's transactional cleanup runs and `recording` never becomes falsely true.
  MODIFY packages/logfire-session-replay/src/capture.ts:
    - Add one internal ownership helper used by console, fetch, XHR, and history wrappers.
    - Mark stopped owned wrappers inactive so they pass through without emitting.
    - Restore a predecessor only when the current method is the wrapper owned by that handle; leave later third-party owners installed.
    - Roll back methods already patched when a multi-method capture setup fails before returning its Stop handle.
    - Preserve original call receiver, arguments, return values, thrown errors, idempotent stop, and safe emit semantics.
  PATTERN: packages/logfire-session-replay/src/capture.ts:safeEmit
  ENABLES: CX-1, CX-2
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-session-replay#test
    - EXPECTED: Replay lease, third-party ownership, missing rrweb stop handling, rollback, and existing payload tests pass.

Task 3: Introduce a transactional session-aware replay controller
  MODIFY packages/logfire-session-replay/src/index.ts:
    - Replace the permanent sampled-off no-op with a lightweight stopped/active controller in browser runtimes; keep the SSR no-op.
    - Separate active-runtime construction from the public controller and maintain a reverse-order cleanup stack as each recorder, timer, listener, and capture module succeeds.
    - On initial setup failure, synchronously unwind all installed resources and rethrow.
    - Monitor the effective session id on the existing one-second lifecycle cadence even while off; avoid rrweb and global capture when mode is off.
    - On detecting a new id, synchronously detach and stop the old rrweb/capture runtime, deactivate its emit path, and expose mode off/recording false before the first await.
    - Serialize the remaining transition: await/report the old full-session flush, continue new activation even if that flush fails, drop unpromoted buffer and late detached-runtime events, and never relabel events across ids.
    - Resolve/persist sampling independently for each new id. Error promotion writes full mode only for the current id.
    - Make manual flush wait for the serialized transition and then flush the current runtime. Make stop mark the controller stopped immediately, await in-flight teardown, suppress pending activation, and remain idempotent.
  MODIFY packages/logfire-session-replay/src/transport.ts as needed:
    - Keep transport scoped to one session runtime or accept an explicit mode on rotation; do not let mode promotion leak to a new id.
  MODIFY packages/logfire-session-replay/src/index.test.ts and transport.test.ts:
    - Cover internal and external rotation across full, buffer, and off decisions; deterministic RNG; error promotion isolation; failed later activation; and no cross-session uploads.
    - Add a delayed old-session flush race: emit after rotation detection, invoke manual flush and stop while the transition is pending, then prove recording stays false, late events are dropped, operations await correctly, and no pending new runtime activates after stop.
  ENABLES: CX-2, CX-3
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-session-replay#test -- -t "sampling|rotates|lifecycle|startup"
    - EXPECTED: Per-session modes, upload ids, dynamic getters, and cleanup are exact and deterministic.

Task 4: Make lifecycle flushing and error reporting host-safe
  MODIFY packages/logfire-session-replay/src/index.ts:
    - Use separate handlers: visibilitychange flushes only when hidden; pagehide always requests keepalive flush.
    - Add a safe error-callback helper that swallows callback failures and use it for fire-and-forget promise paths.
  MODIFY packages/logfire-session-replay/src/transport.ts:
    - Route transport reporting through the same safe callback contract.
  MODIFY packages/logfire-session-replay/src/index.test.ts and transport.test.ts:
    - Cover visible-state pagehide, throwing onError callbacks, rejected flushes, and absence of unhandled rejections.
  ENABLES: CX-4, CX-6
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-session-replay#test -- -t "pagehide|onError|unhandled"
    - EXPECTED: Keepalive is requested on pagehide and consumer callbacks never escape.

Task 5: Keep browser replay state truthful across dynamic modes
  MODIFY packages/logfire-browser/src/sessionReplay.ts:
    - Store the wrapped replay runtime whenever package startup succeeds, including initial off mode; BrowserSessionReplayState.getState already filters dynamic inactive modes.
    - Preserve stop-time state clearing and idempotent cleanup.
    - Guard BrowserSessionReplayOptions.onError so callback failures cannot reject startup.
  MODIFY packages/logfire-browser/src/sessionReplay.test.ts and BrowserSessionSpanProcessor.test.ts:
    - Exercise off-to-active and active-to-off runtime getters and verify replay span attributes appear/disappear with the current session.
    - Cover throwing onError and cleanup after failed package startup.
  ENABLES: CX-3, CX-6
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-browser#test -- -t "session replay|replay state"
    - EXPECTED: Span state matches current dynamic mode and no callback rejection escapes.

Task 6: Contain configured instrumentation failures
  MODIFY packages/logfire-browser/src/index.ts:
    - Keep factories deferred until after provider registration.
    - Resolve/register each factory result as an isolated group with its own cleanup entry.
    - Catch factory and registration failures, diagnose them through OpenTelemetry diag, disable any instruments enabled in the failed group, and continue configuring core telemetry.
    - Preserve reverse-order, idempotent async cleanup for successful configured and auto instrumentations.
  MODIFY packages/logfire-browser/src/index.test.ts:
    - Cover a throwing factory, a mixed array with one failed group, a register failure after enable, continued manual span export, and cleanup of successful groups.
  ENABLES: CX-6
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-browser#test -- -t "instrumentation"
    - EXPECTED: configure returns cleanup, core telemetry remains usable, and no failed group remains enabled.

Task 7: Make Web Vitals startup retryable and its singleton contract explicit
  MODIFY packages/logfire-browser/src/webVitals.ts:
    - On import/registration failure, clear startupPromise and rethrow so configure's existing outer catch reports the failure.
    - Record observer options only after successful registration.
    - Permit later tracer/metric-recorder replacement, but diagnose and ignore attempts to change page-lifetime observer options without duplicate registration.
    - Ensure shutdown detaches only the caller-owned sinks and does not falsely claim observers were unregistered.
  MODIFY packages/logfire-browser/src/webVitals.test.ts and index.test.ts:
    - Fail the first startup and succeed the second; assert one eventual observer registration.
    - Cover unchanged and changed observer options plus latest tracer/recorder routing.
  ENABLES: CX-5
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-browser#test -- -t "Web Vitals"
    - EXPECTED: Failed startup retries, successful startup remains singleton, and mutable sinks route correctly.

Task 8: Finalize the stable page URL and sampling documentation contracts
  MODIFY packages/logfire-browser/src/BrowserSessionSpanProcessor.ts:
    - Stop stamping current-page data into url.full/url.path; retain logfire.page.url.full/path.
  MODIFY packages/logfire-browser/src/BrowserSessionSpanProcessor.test.ts:
    - Keep focused processor coverage for default, sanitized, disabled, and fetch/resource-like spans; assert legacy aliases are absent.
  MODIFY packages/logfire-browser/src/index.test.ts:
    - Add an outside-in public configure test with an in-memory exporter that starts spans under default, sanitized, and disabled URL options and inspects exported attributes, including absence of the legacy aliases.
  MODIFY packages/logfire-browser/README.md and docs/packages/browser.md:
    - Remove alpha-only language and document explicit page keys as stable.
    - State that default full URL includes query/fragment and show urlAttributes sanitization/suppression.
    - Document first-successful-start Web Vitals observer options and retry behavior.
  MODIFY packages/logfire-session-replay/README.md and src/types.ts:
    - Define per-session sampling/rotation and state that only uncaught window errors and unhandled rejections promote a buffer.
    - Document off-mode monitoring without rrweb/global capture and dynamic handle state.
  ENABLES: CX-3, CX-5, CX-7
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-browser#test -- -t "page URL|page attributes"
    - EXPECTED: Public configure/exporter and focused processor tests prove only explicit Logfire page keys under default, sanitized, and disabled configurations.

Task 9: Align repository guidance
  MODIFY AGENTS.md:
    - Add packages/logfire-session-replay to Repository Layout and describe its relationship to the browser integration.
  ENABLES: Release quality gate
  VERIFY:
    - COMMAND: rg -n "logfire-session-replay" AGENTS.md
    - EXPECTED: The canonical repository layout includes the standalone replay package and its browser relationship.

Task 10: Exit alpha and pin the stable version calculation
  ADD .changeset/<generated-name>.md via pnpm run changeset-add:
    - Select patch bumps for @pydantic/logfire-browser and @pydantic/logfire-session-replay.
    - Summarize replay lifecycle hardening, truthful per-session state, retry-safe optional instrumentation, and finalized stable URL/error-promotion contracts.
  MODIFY packages/logfire-browser/package.json:
    - Change the optional replay peer from workspace:* to workspace:^; keep the dev dependency suitable for local exact workspace use unless Changesets requires the same range.
  MODIFY .changeset/config.json:
    - Add ___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH.onlyUpdatePeerDependentsWhenOutOfRange=true with a concise rationale in the PR description/Execution Notes.
    - Keep the existing private-package versioning default; do not add privatePackages:false because the detached simulation expanded unrelated private-example churn.
  RUN node_modules/.bin/changeset pre exit:
    - Commit .changeset/pre.json in mode exit; keep the existing changeset markdown files.
  DELETE .github/workflows/alpha-release.yml:
    - Remove branch-specific/manual alpha publication before any force-push of the rebased branch.
  PRESERVE scripts/create-npm-token.sh:
    - Keep the general npm environment secret helper.
  ENABLES: CX-8
  VERIFY:
    - COMMAND: node_modules/.bin/changeset status --verbose
    - EXPECTED: Browser 0.17.0 and replay 0.1.0; no browser 1.0.0 and no other publishable package release. Private output is limited to the known nextjs-client-side prerelease normalization and versionless nextjs artifact.
  DISPOSABLE_SIMULATION after the stable-ready changes are locally committed:
    - Create a detached worktree from that commit, run node_modules/.bin/changeset version there, and inspect the generated manifest/changelog diff; remove the worktree afterward.
    - EXPECTED: Generated public versions remain exactly 0.17.0 and 0.1.0; any examples/nextjs version:null/changelog artifact is recorded for removal from the later Version Packages PR.

Task 11: Run integrated validation and prepare the reviewed release path
  RUN focused package tests/typechecks, then pnpm run check:
    - Confirm all new lifecycle, failure, compatibility, and exact-output tests pass.
  REVIEW git diff main...HEAD and git status:
    - Confirm every change maps to this PRP and plans/020 remains untracked/unchanged.
  ENABLES: CX-1 through CX-8
  VERIFY:
    - COMMAND: pnpm run check
    - EXPECTED: Build, static checks, typecheck, and all package tests pass.
```

### Post-Implementation Release Runbook

This runbook is intentionally non-executable during PRP implementation. Completing Task 11 means the stable-ready feature branch is locally verified; it does not authorize repository merges or npm publication. Pause at each external checkpoint:

1. **Force-push checkpoint** — obtain authorization to update the rebased branch with `--force-with-lease`; first confirm `.github/workflows/alpha-release.yml` is absent.
2. **Feature PR checkpoint** — obtain authorization to open a ready PR to `main`; wait for CI/review, then separately obtain authorization before merging it.
3. **Version PR review checkpoint** — inspect the generated Version Packages PR read-only for exact `0.17.0`/`0.1.0` versions, stable changelogs, consumed changesets/`pre.json`, and remove any `examples/nextjs` `version: null`/changelog artifact before approval.
4. **Publication checkpoint** — explicitly warn that merging the Version Packages PR triggers the `main` publication workflow, then obtain separate authorization to merge it.
5. **Publication verification** — verify workflow success, GitHub tags/releases, and npm `latest` tags before calling the stable release complete.
6. **Downstream checkpoint** — obtain separate authorization to update the Platform PR to stable package versions.
7. **Branch cleanup checkpoint** — only after publication verification, obtain/confirm authorization and delete the remote and local alpha branch.

### Integration Points

```yaml
SESSION_IDENTITY:
  - packages/logfire-session-replay/src/session.ts — internal expiry source
  - packages/logfire-browser/src/browserSession.ts — browser SDK-owned external id source

REPLAY_STATE:
  - packages/logfire-session-replay/src/index.ts — dynamic public handle
  - packages/logfire-browser/src/sessionReplay.ts — span-facing state adapter
  - packages/logfire-browser/src/BrowserSessionSpanProcessor.ts — emitted active/mode attributes

GLOBAL_CAPTURE:
  - packages/logfire-session-replay/src/index.ts — globalThis controller lease and per-session rrweb runtime
  - packages/logfire-session-replay/src/capture.ts — ownership-aware function patch cleanup

OPTIONAL_INSTRUMENTATION:
  - packages/logfire-browser/src/index.ts — provider registration, lazy factories, cleanup

RELEASE:
  - .changeset/pre.json — alpha exit state
  - .changeset/config.json — peer dependent version policy
  - .github/workflows/main.yml — generated release PR and publish
```

## Validation

```bash
# Focused replay lifecycle
vp run @pydantic/logfire-session-replay#test
vp run @pydantic/logfire-session-replay#typecheck

# Browser integration and public types
vp run @pydantic/logfire-browser#test
vp run @pydantic/logfire-browser#typecheck

# Stable release calculation after pre exit
node_modules/.bin/changeset status --verbose

# Full repository gate
pnpm run check

# Diff hygiene
git diff --check
git status --short
```

### Required Test Coverage

- [x] Second controller rejection while owner is active, sampled off, or recovering from later activation failure; release after stop/initial failure; clean subsequent start.
- [x] Third-party wrapper ownership and partial capture setup rollback.
- [x] Initial and later replay startup failure cleanup followed by successful restart.
- [x] Missing rrweb stop callback fails startup and leaves `recording` false with the lease released.
- [x] Internal and external session rotation across full/buffer/off, including dynamic span state.
- [x] Error promotion scoped to one session and no cross-session event upload.
- [x] Delayed old-session flush race with truthful transition state, waiting manual flush, and stop preventing pending activation.
- [x] Visible-state pagehide keepalive flush, including while an ordinary upload is still in flight.
- [x] Throwing error callbacks and rejected background promises do not escape.
- [x] Throwing instrumentation factories/registration preserve core configure and cleanup.
- [x] First and partial Web Vitals startup failures retry without duplicating successful observers; completed registration stays singleton.
- [x] Public configure/exporter coverage proves stable page attributes omit alpha legacy aliases and retain sanitization/disable behavior.
- [x] Changesets exact local version plan; generated release-PR artifact review remains a separately gated runbook step.

### Consumer Verification Plan

| Scenario | Exercise                                                                                               | Expected observable evidence                                                                                                           | Environment and prerequisites                           |
| -------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `CX-1`   | Start replay A, attempt replay B, stop A, then start replay C; also install later third-party wrappers | B fails without disturbing A, C succeeds after lease release, and third-party globals retain identity with no stopped Logfire emission | Vitest jsdom, fake fetch/XHR/history/console            |
| `CX-2`   | Force a late setup assignment/capture failure, inspect host globals/listeners, then start again        | No leaked behavior from failed attempt; second handle records normally                                                                 | Vitest jsdom with controlled property descriptors/mocks |
| `CX-3`   | Use deterministic ids/time/RNG through public replay and browser configure APIs                        | Mode/recording/uploads/span attributes change per session without mixed ids                                                            | Vitest fake timers and recording fetch                  |
| `CX-4`   | Emit replay data and dispatch pagehide while visible                                                   | One keepalive upload attempt                                                                                                           | Vitest jsdom and recording fetch                        |
| `CX-5`   | Mock Web Vitals import failure then success through configure                                          | First attempt diagnosed; second registers once and emits through latest sinks                                                          | Browser package Vitest mock boundary                    |
| `CX-6`   | Configure throwing factory/onError fakes and observe host rejection events                             | Configure returns cleanup/core spans work; zero unhandled rejection                                                                    | Browser package Vitest with OTel fakes                  |
| `CX-7`   | Start spans with default/sanitized/disabled URL options                                                | Only explicit Logfire page keys appear with documented values                                                                          | Browser processor/configure tests                       |
| `CX-8`   | Run Changesets status and a disposable detached version simulation                                     | Exact stable public versions with no browser 1.0.0 or other publishable package                                                        | Local workspace and disposable worktree                 |

The separately authorized release runbook records Version Packages PR and npm evidence after this PRP is complete; it is not part of the `CX-8` implementation grade.

## Unknowns & Risks

- Dynamic per-session recording adds asynchronous transition state to a currently mostly synchronous entry point. The design must keep the public API unchanged and serialize transitions without uploading events under the wrong id.
- Browser session rotation is observed on a one-second monitor. Tests can prove deterministic transition semantics but not every browser's timer throttling behavior in background tabs; pagehide/visibility flushes remain the lifecycle backstop.
- OpenTelemetry may enable part of an instrumentation group before registration throws. The implementation must explicitly disable the supplied group on failure and test the fake equivalent; if the real API cannot contain it, pause and reassess.
- Removing legacy page `url.*` aliases is intentional for stable semantics, but execution must recheck current supported downstream consumers immediately before removal.
- The generated Version Packages PR is an external artifact and may include private-package churn not visible from `changeset status`; its separately gated review remains mandatory before publication.
- The Platform PR remains separate and conflicting. Stable package publication does not itself complete the product rollout.

**Confidence: 8/10** for one-pass implementation success. Evidence and release mechanics are strong; the main complexity is implementing per-session runtime transitions without expanding the public API.

## Execution Notes

### Scope Expansions

- None. Implementation stayed within the expected files and public contract.

### Deviations

- The session-aware replay controller remains in `packages/logfire-session-replay/src/index.ts`; no additional internal controller module was necessary.
- `ReplayTransport.rotate()` remains available internally, but the controller now creates one transport per browser session so an old session can be detached before its final flush without relabeling queued events.
- The detached Changesets version simulation was not repeated during shared-workspace execution. The current `changeset status --verbose` result matches the disposable simulation recorded in Spike Evidence; the generated Version Packages PR remains a separate gated review.
- Mode 4 clarified that “reconfigure” was too broad for the supported OpenTelemetry lifecycle. The contract now claims repeated optional-feature sink updates, not cleanup followed by a second `configure()` in the same global realm; unregistering application-owned OpenTelemetry globals would be unsafe and was not added.

### Unresolved Risks

- Browser timer throttling can delay detection of a session rotation; `visibilitychange` and unconditional `pagehide` flushing remain the lifecycle backstop.
- Changesets still reports expected private prerelease normalization. The generated Version Packages PR must remove the versionless private example artifact and be reviewed before publication.
- Stable publication, npm dist-tag verification, downstream Platform rollout, and branch deletion remain outside this implementation and require the separate release checkpoints.
- Keepalive upload is best-effort: asynchronous `headers`/functional `token` callbacks can outlive the page-freeze boundary, and one individually oversized replay event cannot be split safely. The public README now recommends synchronously available proxy credentials and an explicit pre-navigation `flush()` when delivery is critical.

## Verification Record

### Consumer Acceptance

| Scenario | Grade             | Evidence                                                                                                                                                                              | Limitations                                                                                                                          |
| -------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `CX-1`   | DIRECTLY VERIFIED | Built-package jsdom probe with real rrweb plus focused public ownership tests proved deterministic rejection, retained third-party wrappers, inert stopped wrappers, and restart.     | jsdom represents one browser realm; duplicate package instances were separately imported in the focused suite.                       |
| `CX-2`   | DIRECTLY VERIFIED | Built-package probe forced a read-only fetch assignment after earlier setup, observed restored globals/timers/listeners, then started successfully; focused rollback tests agree.     | Non-Logfire jsdom selector listeners were identified and excluded from leak accounting.                                              |
| `CX-3`   | DIRECTLY VERIFIED | Public replay tests exercised external and internal full/off/buffer rotation, upload ids, races, and promotion isolation; a built public configure probe observed dynamic span state. | The one-second production monitor is driven deterministically by fake time in repository tests.                                      |
| `CX-4`   | DIRECTLY VERIFIED | Public replay-handle test observed `keepalive: true` on visible-state pagehide; transport coverage proves it starts while an ordinary upload is in flight.                            | Async credential callbacks and one indivisible oversized event remain documented best-effort unload limitations.                     |
| `CX-5`   | PROXY VERIFIED    | Controlled `web-vitals/attribution` boundary proved first and partial failure recovery, no duplicate observers, inert partial observers, locked options, and latest sinks.            | The PRP permits this proxy because jsdom cannot reproduce a real browser chunk loader.                                               |
| `CX-6`   | PROXY VERIFIED    | Public configure probe observed a core span and zero host rejections with rejected replay loading/throwing `onError`; OTel fakes proved factory/registration containment and cleanup. | The PRP explicitly permits OpenTelemetry fakes for failed registration behavior.                                                     |
| `CX-7`   | DIRECTLY VERIFIED | Fresh-realm built-package probes with a real `InMemorySpanExporter` proved default, sanitized, and disabled URL behavior with no legacy aliases.                                      | The in-repo test observes a custom processor; the built/public exporter probe supplies the required export-boundary evidence.        |
| `CX-8`   | DIRECTLY VERIFIED | Current `changeset status --verbose` reports browser `0.17.0`, replay `0.1.0`, no major/public extra package; prior disposable version simulation produced the same versions.         | Current detached versioning was not rerun; generated Version Packages PR inspection/publication follow the separately gated runbook. |

### Compliance and Engineering Review

- **PRP compliance**: Independent re-audit found the implementation compliant with no runtime blocker. The built/public CX-7 exporter probe intentionally supplies evidence that is broader than the in-repo custom-processor test.
- **Engineering review**: Independent final re-review found no implementation blockers or actionable findings. Partial Web Vitals observers remain inert until complete registration, failed sinks are cleared, keepalive concurrency is tracked, and documented unload limitations match the implementation.
- **Final validation**: `pnpm run check` passed across all packages on the final source state; replay has 95 passing tests and browser has 90. Focused package typechecks, `vp check`, `git diff --check`, and exact Changesets status all passed.
