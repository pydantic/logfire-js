# Finalize the browser optional-feature API

## Goal

Finalize the first stable browser optional-feature contract. Preserve the
callable result of `configure()` while adding an optional, generation-scoped
`cleanup.sessionReplay` facade with live `mode`/`recording`, awaitable `flush()`,
and replay-only idempotent `stop()`. Keep replay configuration top-level,
degrade failed Web Vitals metrics startup to span-only reporting, make Web
Vitals point events exact Logfire `log` spans, suppress false late-callback
diagnostics after shutdown, and publish one consistent type/runtime/docs/release
contract.

## Why

- Browser consumers need to flush replay before controlled navigation or stop
  replay without tearing down tracing, but existing cleanup callers must remain
  source- and runtime-compatible.
- Metrics are an optional aggregate path. A failed metrics startup must not
  disable the independent Web Vitals span path or cause an unauthenticated
  export.
- The first stable API must be truthful about browser-session inactivity,
  asynchronous lifecycle credentials, and surfaces that the implementation
  never emits or calls.
- Parent roadmap scenario `CX-8` requires the built public types, runtime,
  package README, browser docs, and release note to describe the same behavior.

## Success Criteria

- [x] `configure()` returns an exported callable `BrowserConfigureHandle` that
      remains assignable to `() => Promise<void>` and has `sessionReplay` only
      when replay was configured.
- [x] The exported `BrowserSessionReplayHandle` contains only `mode`,
      `recording`, `flush()`, and replay-only idempotent `stop()`; session
      identity remains on `getBrowserSessionId()`.
- [x] The facade is synchronously available for configured replay, is
      generation-scoped, reports conservative state before readiness/after
      failure/after stop, serializes early lifecycle calls, and coordinates
      safely with full cleanup and reconfiguration.
- [x] A browser-metrics startup failure emits an exact spans-only degradation
      diagnostic and still starts Web Vitals spans without a metric recorder;
      rejected authentication headers still issue no metrics request.
- [x] Every Web Vitals point span has exact
      `logfire.span_type = 'log'`, and observer callbacks arriving after their
      generation shuts down silently no-op rather than reporting a false
      `missing Web Vitals tracer` error.
- [x] Browser session docs state that automatic inactivity currently means no
      span starts after the initial replay-start touch (subsequent replay
      events alone do not refresh it), while accurately noting the explicit
      `getBrowserSessionId()` touch.
- [x] Dead replay surfaces are dispositioned explicitly, both public guides
      preserve the asynchronous replay-credential/unload caveat, and one
      focused Changeset covers every package-visible R6 change.
- [x] A built minimal consumer directly proves legacy callable cleanup and the
      new lifecycle facade across lazy readiness, replay-only stop, full
      cleanup, repeated calls, startup failure, and sequential generations.

## Assurance

- **Profile**: Standard
- **Rationale**: R6 is one bounded public browser-package contract with a
  nontrivial callable return type and asynchronous generation ownership. The
  prior lifecycle spike resolves the architecture-level uncertainty; the work
  is reversible before stable publication, changes no authentication or wire
  schema, and has one integrated browser-consumer validation loop. Standard
  requires a cold review here because the public compatibility boundary is
  nontrivial.

## Roadmap Context

- **Parent roadmap**:
  `plans/roadmaps/001-browser-rum-release-remediation.md`
- **Roadmap step**: `R6` — finalize browser optional-feature API and
  degradation contract.
- **Satisfied dependencies**: R2 provider lifecycle is verified by PRP 024; R3
  delivery and async-credential documentation are verified by PRP 025; R4
  optional failure and authenticated metrics-header containment are verified by
  PRP 026; R5 privacy defaults are verified by PRP 027; D3, D4, and metrics
  degradation are settled in the roadmap and Spike 05.
- **Inherited decisions and invariants**: one active/cleaning provider
  generation; callable cleanup promise identity and failure aggregation;
  top-level `sessionReplay`; lazy optional-peer loading; replay-only stop versus
  full cleanup; `getBrowserSessionId()` as the identity API; no empty-header
  fallback; R3 best-effort unload/async-credential caveat; R5 privacy defaults.
- **Contract produced for later steps**: built public type/runtime/docs and
  direct minimal-consumer evidence for parent `CX-8`, consumed by R8 release
  reconciliation and R9 package smoke/publication.

## Consumer Contract

### Consumer and Public Boundary

- **Consumer(s)**: browser SDK integrators enabling replay and/or Web Vitals,
  including existing alpha consumers that call the returned cleanup function.
- **Public or supported boundary**: top-level
  `configure({ sessionReplay, rum, metrics })`, its returned callable handle,
  `getBrowserSessionId()`, emitted Web Vitals spans/metrics requests,
  diagnostics, built declarations, package README, browser docs, and Changeset.
- **Entry point and prerequisites**: built browser package, optional replay
  module supplied through `sessionReplay.load`, browser-safe trace/replay/metric
  endpoints, and a browser-like runtime. Replay remains top-level; Web Vitals
  metrics require top-level metrics configuration.
- **Current observable behavior**: cleanup is callable but exposes no replay
  controls; metrics-enabled Web Vitals do not start if metrics startup fails;
  late callbacks after cleanup can report `missing Web Vitals tracer`; Web
  Vitals spans lack `logfire.span_type`; inactivity docs do not define the
  activity source.
- **Observable promise**: old cleanup syntax still works; replay-configured
  generations expose safe lifecycle control immediately; replay stop does not
  stop tracing; complete cleanup remains authoritative; Web Vitals retain spans
  under metrics startup failure with an explicit diagnostic and never bypass
  configured credentials.
- **Must remain compatible with**: browser `0.17.0-alpha.2` top-level replay
  options, optional replay peer loading, cleanup ordering/promise identity,
  R2 sequential generations, R3/R4/R5 contracts, OpenTelemetry API 1.9.1 and
  browser SDK 2.8.0, and the replay envelope.
- **Not claimed**: guaranteed replay delivery after termination; replay control
  when replay was not configured; asynchronous getters; route-level Web
  Vitals; recovery of a failed metrics transport; or a new replay session-id
  surface.

### Acceptance Scenarios

| ID      | Given                                                                                                                                                                              | When                                                                                                                                                                                                                   | Then                                                                                                                                                                                                                                                                                                                                                     | Exact exercise and prerequisites                                                                                                                                                                                                       | Required evidence                                                                             |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `CX-8a` | A minimal consumer uses built browser output, first with legacy cleanup syntax and then with delayed, failed, and successful replay modules across sequential provider generations | It reads facade state before readiness, calls early `flush()`/`stop()`, stops replay only, starts a span, performs full cleanup repeatedly, and invokes an old generation handle after configuring the next generation | Legacy cleanup compiles and runs unchanged; `sessionReplay` is absent unless configured and otherwise exists synchronously; state is conservatively `off`/`false` until ready and after failure/stop; ordered early calls settle; replay stop occurs once without stopping tracing; full cleanup occurs once; old handles cannot affect a new generation | Build package declarations/runtime; compile and run `test-fixtures/optional-feature-api` through public package imports and loopback receipts/counters                                                                                 | DIRECT REQUIRED — this is the public compatibility and ownership boundary for parent `CX-8`   |
| `CX-8b` | Public browser configuration enables Web Vitals spans plus metrics, and metrics startup fails or configured metric headers throw synchronously/reject asynchronously               | Web Vital callbacks fire before replay-only stop, after replay-only stop, and after full cleanup                                                                                                                       | Before and after replay-only stop an exact `web_vital.*` span with `logfire.span_type = 'log'` is produced, the startup failure emits the selected spans-only diagnostic, and neither header failure sends a request; after full cleanup the callback produces no span/metric and no false missing-tracer diagnostic                                     | Public `configure()` integration with real span exporter, controlled Web Vitals callback, failed metrics startup, installed exporter request recorder for both header-failure modes, replay-only stop, then full cleanup/late callback | DIRECT REQUIRED — public startup/degradation and emitted telemetry are observed, not inferred |
| `CX-8c` | An integrator reads the built declarations, package README, browser docs, and focused Changeset                                                                                    | They follow the documented top-level replay configuration and lifecycle guidance                                                                                                                                       | All surfaces expose one callable/facade contract, retain top-level placement and privacy defaults, define span-based inactivity, preserve the async credential/unload caveat, distinguish replay-only stop from full cleanup, and record the exact browser/replay package release impact                                                                 | Inspect built `dist/index.d.ts`/`.d.cts`, both guides, generated fixture source, and the focused Changeset; run exact grep/type assertions                                                                                             | DIRECT REQUIRED — these are shipped contract surfaces for parent `CX-8`                       |

## Research Summary

### Vetted Repository Findings

- `packages/logfire-browser/src/index.ts:438-448,585-700` — public
  `configure()` returns a bare cleanup function; it already owns replay startup,
  metrics startup, Web Vitals startup, generation cleanup, and stable cleanup
  promise identity. — **PRP impact**: augment this existing callable and keep
  all replay operations in the same generation closure.
- `packages/logfire-browser/src/index.ts:593-628` — metrics-enabled Web Vitals
  throws when the metrics runtime is absent, and the shared catch disables the
  entire Web Vitals path. — **PRP impact**: start Web Vitals without a recorder
  after an exact spans-only diagnostic.
- `packages/logfire-browser/src/webVitals.ts:35-72,197-317` — page-lifetime
  observers use mutable current tracer/recorder slots; cleanup clears those
  slots but leaves callbacks registered, so a late callback reaches the
  missing-tracer diagnostic. — **PRP impact**: model active ownership explicitly
  and silently ignore callbacks after the owning handle shuts down.
- `packages/logfire-browser/src/webVitals.ts:197-211` — point-event spans are
  created without a Logfire span-type attribute. — **PRP impact**: stamp the
  exported `ATTRIBUTES_SPAN_TYPE_KEY` constant with exact value `log` before
  ending every Web Vital span.
- `packages/logfire-browser/src/sessionReplay.ts:9-16,129-322` — the browser
  bridge already wraps runtime getters/errors and idempotent replay stop, but
  its wrapped `getSessionId()` is unused by production browser code. — **PRP
  impact**: reuse the containment pattern for the public four-member facade and
  keep identity only on `getBrowserSessionId()`.
- `packages/logfire-browser/src/browserSession.ts:120-145,250-272`,
  `BrowserSessionSpanProcessor.ts:46-51`, and `sessionReplay.ts:148-151` — span
  start calls `touch()`; replay startup initializes/touches once before lazy
  loading, its subsequent hot session callback only peeks, and explicit
  `getBrowserSessionId()` also touches. — **PRP impact**: document automatic
  inactivity as span inactivity after the initial replay-start touch,
  subsequent replay events as non-activity, and the explicit getter touch.
- `packages/logfire-session-replay/src/transport.ts:148-161` — `rotate()` has
  no production caller; session changes replace the whole active runtime. —
  **PRP impact**: remove the internal method and its direct-only tests.
- `packages/logfire-session-replay/src/recorder.ts:5-17,67-73` —
  `RecorderHandle.takeFullSnapshot()` is exposed internally and tested but never
  called by production; checkout timing is configured through rrweb options. —
  **PRP impact**: remove the dead handle member and stale test.
- `packages/logfire-session-replay/src/types.ts:64-68` and
  `capture.test.ts:533-563` — exported `NavigationPayload.kind` includes
  `'load'`, while capture emits only push/replace/pop and rrweb already emits its
  native Load event. — **PRP impact**: narrow the pre-stable public union and
  cover the replay package in the focused Changeset rather than inventing a
  redundant custom load event.
- `packages/logfire-browser/README.md:236-281` and
  `docs/packages/browser.md:240-280` — both integrated guides already contain
  the R3 async credential/page-freeze warning and R5 privacy defaults. — **PRP
  impact**: preserve this wording while adding the now-available facade guidance.
- `packages/logfire-browser/dist/index.d.ts:111-147,317` — current built types
  expose the internal replay runtime shape but still declare `configure()` as a
  bare function result. — **PRP impact**: assert the final public declarations,
  including no `getSessionId()` on the facade and CJS declaration parity.

### External Constraints

None. Installed package source and types establish every relevant contract;
R6 does not depend on an unstable external API or require new guidance.

### Settled Decisions and Rejected Alternatives

- **Decision**: export `BrowserConfigureHandle` as a callable interface with an
  optional readonly `sessionReplay`, and export `BrowserSessionReplayHandle`
  with exactly `mode`, `recording`, `flush()`, and `stop()`. — **Evidence**:
  settled D3 and conclusive Spike 05.
- **Decision**: create the facade synchronously only for configured replay and
  bind it to that configure generation. Getters are conservative before lazy
  readiness/after failure/stop. Public operations serialize in call order;
  `stop()` memoizes one promise, later `flush()` joins/no-ops, and full cleanup
  uses the same stop operation. — **Evidence**: Spike 05 race model and R2
  generation ownership.
- **Decision**: keep `sessionReplay` at the top level of `LogfireConfigOptions`.
  — **Evidence**: settled D4 and alpha compatibility.
- **Child-selected detail**: when the metrics runtime is unavailable, call
  `diag.warn` once with exact text
  `logfire-browser: browser metrics did not start; continuing Web Vitals with span reporting only`,
  then call `startBrowserWebVitals` without a metric recorder. — **Rationale**:
  the roadmap settles an explicit diagnostic but not its wording or severity;
  warning severity distinguishes recoverable span-only degradation from total
  Web Vitals startup failure, and exact text makes the behavior testable.
- **Decision**: remove dead internal `ReplayTransport.rotate()` and
  `RecorderHandle.takeFullSnapshot()`, and remove never-emitted public
  `NavigationPayload.kind = 'load'`. — **Evidence**: repository call search and
  existing rrweb native Load event; this is the last pre-stable opportunity to
  avoid a false public union member.
- **Rejected**: replace cleanup with an object, add a global replay getter, move
  replay under `rum`, expose `getSessionId()` on the facade, or make getters
  asynchronous. — **Reason**: each contradicts settled D3/D4, compatibility,
  or generation ownership.
- **Rejected**: synthesize `{}` headers, retry unauthenticated metrics, or
  disable Web Vitals spans with metrics. — **Reason**: violates R4 and the
  settled credential/degradation contract.
- **Rejected**: emit a redundant custom navigation `load` event merely to keep
  the dead union member. — **Reason**: rrweb already represents document load,
  and adding telemetry has greater compatibility/privacy cost than correcting
  the pre-stable type.

### Spike Evidence

- `plans/research/roadmaps/001-browser-rum-release-remediation/spike-05-public-replay-lifecycle-handle.md`
  — **Question**: can replay lifecycle be exposed without breaking callable
  cleanup or lazy startup? — **Result/decision**: the augmented callable is
  type-compatible and safely supports early/repeated operations; use the
  generation-scoped facade. — **Limits**: scratch state model only; `CX-8a`
  supplies built production type/runtime evidence.
- No new spike needed. Live source resolves metrics, late-callback, span-type,
  inactivity, dead-surface, docs, and test strategy questions directly.

### Validation Baseline

| Command                                                                              | Status                        | Observed or expected result                                                                              |
| ------------------------------------------------------------------------------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| `vp run @pydantic/logfire-browser#test`                                              | Verified                      | 12 files, 145 tests passed at `aae49f6` on 2026-07-13                                                    |
| `vp run @pydantic/logfire-browser#typecheck`                                         | Verified                      | TypeScript passed at `aae49f6`                                                                           |
| `vp run @pydantic/logfire-session-replay#test`                                       | Verified                      | 9 files, 146 tests passed at `aae49f6`                                                                   |
| `pnpm run check`                                                                     | Verified inherited baseline   | Passed in PRP 027 verification at source commit `aae49f6`; rerun after R6 implementation                 |
| `node_modules/.bin/changeset status --output /tmp/r6-planning-changeset-status.json` | Verified with known R8 defect | Browser plans `0.17.0`, replay plans `0.1.0`; pre-existing private Next.js null version remains R8-owned |
| Built minimal optional-feature consumer                                              | Missing                       | Created and run by this PRP; required for parent `CX-8`                                                  |

### Research Coverage

- **Depth**: Standard
- **Inspected**: parent roadmap and combined review; Spike 05; complete R2-R5
  PRPs and verification records; browser configure/types/replay bridge/session,
  metrics, Web Vitals, focused unit/integration tests, built declarations,
  package README, browser docs, package manifest, Changesets; replay public
  handle/types and dead internal surfaces; recent relevant history.
- **Not inspected**: proxy/example implementation (R7), final Changesets
  normalization (R8), publication/registry workflows (R9), Platform internals,
  and unrelated Node/Cloudflare packages because they do not control R6.
- **Research confidence**: HIGH — all public decisions are settled, every
  promise has an achievable direct evidence surface, and no high-impact
  empirical assumption remains.

## Execution Contract

- **Planned at commit**: `aae49f6`
- **Planning baseline**: preserve the existing modified
  `plans/roadmaps/001-browser-rum-release-remediation.md` and untracked
  `plans/research/roadmaps/001-browser-rum-release-remediation/spike-05-public-replay-lifecycle-handle.md`.
  The branch is three commits ahead of its remote. Do not overwrite, stage, or
  commit those user-owned planning records.

### Expected Changes

- `packages/logfire-browser/src/index.ts` and `index.test.ts` — exported
  callable/facade types, generation-scoped replay operation coordination,
  cleanup reuse, spans-only metrics degradation, and exact lifecycle tests.
- `packages/logfire-browser/src/sessionReplay.ts` and tests — separate the
  loaded peer runtime from the browser-facing four-member control surface and
  remove the dead browser wrapper session-id member.
- `packages/logfire-browser/src/webVitals.ts` and tests — exact Logfire span
  type and inactive late-callback behavior.
- `packages/logfire-browser/src/browserConfigure.integration.test.ts` and/or a
  focused new integration test — public span/degradation/header evidence.
- `packages/logfire-browser/src/browserMetrics.integration.test.ts` — preserve
  installed-exporter zero-request evidence when configured headers reject.
- `packages/logfire-browser/src/browserSession.ts` — type comment defining
  automatic inactivity precisely; no runtime timeout semantic change.
- `packages/logfire-session-replay/src/transport.ts`, `recorder.ts`, `types.ts`
  and focused tests — remove the three dispositioned dead surfaces.
- `packages/logfire-browser/test-fixtures/optional-feature-api/` — built public
  consumer, controlled lazy replay modules, loopback state/receipts, type
  assertions, and exact verifier.
- `packages/logfire-browser/README.md` and `docs/packages/browser.md` — public
  facade examples, replay-only/full cleanup distinction, degradation/span type,
  inactivity definition, top-level placement, and preserved credential caveat.
- `.changeset/browser-optional-feature-api.md` — focused patch entries for
  browser API/behavior and replay pre-stable dead public type cleanup.
- `plans/roadmaps/001-browser-rum-release-remediation.md` — R6 child link and
  `PRP READY` status only after this PRP passes cold review.

### Explicitly Out of Scope

- Moving replay under `rum`, adding session identity to the replay facade, or
  changing replay privacy/sampling/delivery/authentication/envelope behavior.
- Provider lifecycle internals, concurrent configurations, cleanup failure
  recovery, or duplicate-package support owned by R2.
- Proxy/example server fixes (R7), final version/changelog reconciliation (R8),
  release integration/publication (R9), or adjacent Platform changes.
- Route-level/soft-navigation Web Vitals, global meter-provider ownership, or
  metrics transport recovery/retry policy.
- Changing browser-session timeout calculations; R6 documents the existing
  activity source only.

### Scope Expansion Rule

Additional files may change only to keep the facade helper/test fixture
cohesive or to update generated declarations through the normal build. Record
each added file and rationale during execution. Pause if implementation needs a
new public option, changes cleanup/provider architecture, changes replay wire or
authentication semantics, weakens R3-R5, or requires a separate deployment or
release loop.

### Pause and Reassess If

- The augmented callable is not assignable to the legacy cleanup function in
  built ESM and CJS declarations.
- A generation-scoped facade cannot coordinate early flush/stop and full
  cleanup without changing R2 cleanup identity/order or allowing an A handle to
  affect B.
- Web Vitals spans cannot start independently after metrics startup failure, or
  the installed exporter sends after configured header resolution rejects.
- Late callbacks cannot distinguish inactive shutdown from a genuine active
  tracer failure without replacing page-lifetime observer architecture.
- Removing a dead surface reveals an actual production consumer or requires a
  new replay event/wire field.
- Implementation overlaps the preserved roadmap/Spike 05 records in a way that
  would erase their decisions.

## Context

### Key Files

- `packages/logfire-browser/src/index.ts` — public configure return, optional
  startup promises, metrics degradation, and full cleanup owner.
- `packages/logfire-browser/src/sessionReplay.ts` — loaded peer boundary,
  containment, live replay state, and reusable control behavior.
- `packages/logfire-browser/src/webVitals.ts` — page-lifetime callback registry,
  current generation slots, and point-span creation.
- `packages/logfire-browser/src/browserMetrics.ts` — optional local meter
  runtime and authenticated exporter configuration.
- `packages/logfire-browser/src/browserSession.ts` and
  `BrowserSessionSpanProcessor.ts` — inactivity activity source.
- `packages/logfire-session-replay/src/{index,transport,recorder,types}.ts` —
  stable peer handle plus dead internal/public surfaces.
- `packages/logfire-browser/test-fixtures/{provider-lifecycle,privacy-defaults}/`
  — built-package, sequential-generation, state, receipt, and verifier patterns.
- `packages/logfire-browser/README.md` and `docs/packages/browser.md` — shipped
  integrated replay/Web Vitals/lifecycle contract.

### Gotchas

- A callable interface is compatible only if the runtime value remains the same
  function object; attach the readonly property to that function rather than
  returning a wrapper object.
- Do not declare facade methods `async` if repeated `stop()` calls must return
  the same promise object; return the stored promise directly.
- `sessionReplay` must exist synchronously when configured even though
  `sessionReplay.load()` is lazy. Getters cannot await and therefore return
  `off`/`false` until a healthy runtime is ready.
- Serialize facade operations. An early `flush()` followed by `stop()` must
  flush then stop once; a flush after stopping/full cleanup must join or no-op
  without touching the stopped recorder.
- Full cleanup begins provider cleaning synchronously and remains authoritative;
  it must reuse replay-only stop while preserving the established later cleanup
  order and error aggregation.
- Web Vitals observers intentionally live for the page. A late callback after
  generation shutdown is expected, not a missing-tracer fault.
- Metrics header rejection is an export failure, not metrics startup failure.
  Preserve the R4 installed-exporter zero-request test in addition to the new
  startup-degradation test.
- `getBrowserSessionId()` itself touches activity. Documentation should say
  replay events do not refresh inactivity and automatic refresh is span-based,
  while acknowledging explicit getter access.
- The new Changeset should assert exactly browser+replay patch entries without
  claiming that R8's known null-version baseline is repaired.

## Implementation Blueprint

### Data Models

```ts
export interface BrowserSessionReplayHandle {
  readonly mode: 'full' | 'buffer' | 'off'
  readonly recording: boolean
  flush(): Promise<void>
  stop(): Promise<void>
}

export interface BrowserConfigureHandle {
  (): Promise<void>
  readonly sessionReplay?: BrowserSessionReplayHandle
}
```

The implementation owns one private replay lifecycle per configure generation:
the startup promise, last ready runtime, ordered operation tail, memoized stop
promise, and full-cleanup-started/stopped state. No state is global and no
facade contains a session id.

### Tasks

```yaml
Task 1: Add failing public-contract characterization
  MODIFY packages/logfire-browser/src/index.test.ts:
    - Type and runtime characterize legacy assignment/call syntax and the optional synchronous sessionReplay property.
    - Cover absent replay, delayed readiness, startup failure, live/off getters, early flush-before-stop ordering, stop-before-flush no-op, replay-only stop, full cleanup reuse, repeated promise identity, and cleanup error ordering.
    - Cover A replay stop/full cleanup -> B configure; prove stale A facade calls never reach B.
    - Add metrics-startup failure coverage requiring Web Vitals startup without a recorder and the exact spans-only diagnostic.
  MODIFY packages/logfire-browser/src/sessionReplay.test.ts:
    - Characterize peer runtime containment while removing browser-wrapper getSessionId expectations; session identity remains separately tested through getBrowserSessionId.
  SUPPORTS: CX-8a, CX-8b; expected failures pin current missing facade/degradation.
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-browser#test -- -t "session replay|cleanup|Web Vitals|metrics"
    - EXPECTED: New facade/degradation assertions fail before implementation and existing R2-R5 behavior remains green.

Task 2: Implement the callable generation-scoped replay facade
  MODIFY packages/logfire-browser/src/index.ts:
    - Export BrowserSessionReplayHandle and BrowserConfigureHandle; return BrowserConfigureHandle from configure and through the default export type.
    - Build the facade synchronously only when resolved sessionReplay options exist, attach it to the same cleanup function object, and leave the property absent otherwise.
    - Track the ready wrapped runtime from the existing startup promise; expose off/false before readiness, after failure, and after stop.
    - Serialize public replay operations in invocation order. Let flush wait for readiness; memoize replay-only stop; make later flush join/no-op after stop/full cleanup.
    - Have full cleanup synchronously mark cleaning then reuse the facade stop operation before unregister/Web Vitals/metrics/trace/session cleanup.
    - Preserve cleanup promise identity, first-error aggregation, active/cleaning rejection, and every inherited cleanup step order.
  MODIFY packages/logfire-browser/src/sessionReplay.ts:
    - Distinguish the loaded peer runtime (which has getSessionId) from the browser-facing wrapped control surface (mode/recording/flush/stop only).
    - Preserve safe getters, reporter containment, state clearing, and idempotent underlying stop; remove unused last-known/getSessionId wrapper code.
  ENABLES: CX-8a and parent CX-8.
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-browser#test -- -t "session replay|cleanup|reconfig"
    - EXPECTED: All startup/race/repeated/generation cases pass with exact call and promise counts.
    - COMMAND: vp run @pydantic/logfire-browser#typecheck
    - EXPECTED: Callable intersection and peer/internal/public replay types compile without casts leaking to declarations.

Task 3: Preserve spans under metrics degradation and finalize Web Vitals semantics
  MODIFY packages/logfire-browser/src/index.ts:
    - When Web Vitals metrics were requested but browserMetricsStartupPromise yields undefined, emit the child-selected exact diagnostic through diag.warn and call startBrowserWebVitals with the generation tracer and no metricRecorder.
    - Keep ordinary Web Vitals startup failure handling separate and preserve metric runtime cleanup when startup succeeds.
  MODIFY packages/logfire-browser/src/webVitals.ts:
    - Stamp ATTRIBUTES_SPAN_TYPE_KEY = 'log' on every Web Vital span.
    - Track whether a current Web Vitals generation is active; registered callbacks silently return after its owning handle shuts down, while active tracer/recorder exceptions retain existing diagnostics.
    - Keep page-lifetime observer registration and newer-generation ownership safety.
  MODIFY packages/logfire-browser/src/webVitals.test.ts and index.test.ts:
    - Assert the complete stable base attribute object includes exact logfire.span_type: log.
    - Fire a retained callback after shutdown and assert no span, metric record, or missing-tracer diagnostic; then start B and prove the same observer routes to B.
    - Assert startup failure degrades to spans without creating a metric recorder and emits the exact warning once.
  MODIFY packages/logfire-browser/src/browserConfigure.integration.test.ts and browserMetrics.integration.test.ts:
    - Through public configure/real span export, prove a metric-startup failure still yields the point span.
    - Preserve the installed exporter test that asynchronously rejected configured headers issue zero fetches, and add the synchronous-throw zero-fetch case; combine with span evidence when practical without replacing either direct boundary.
  ENABLES: CX-8b and parent CX-8.
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-browser#test -- -t "Web Vitals|metrics exporter|spans only|late"
    - EXPECTED: Exact point span, degradation warning, inactive callback, B routing, and zero unauthenticated request assertions pass.

Task 4: Remove dead replay surfaces before stable publication
  MODIFY packages/logfire-session-replay/src/transport.ts and transport.test.ts:
    - Remove ReplayTransport.rotate and tests that exercise only that dead method; preserve runtime replacement on session changes in index.ts and its public tests.
  MODIFY packages/logfire-session-replay/src/recorder.ts and recorder.test.ts:
    - Remove RecorderHandle.takeFullSnapshot, the unused rrweb static type member, wrapper method, and direct-only test; preserve checkoutEveryNms behavior.
  MODIFY packages/logfire-session-replay/src/types.ts and capture tests:
    - Narrow NavigationPayload.kind to push | replace | pop and retain exact public capture assertions.
  ENABLES: truthful CX-8c public types and R8 release metadata.
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-session-replay#test && vp run @pydantic/logfire-session-replay#typecheck && vp run @pydantic/logfire-session-replay#build
    - EXPECTED: Session replacement, recorder checkout, navigation capture, and built declarations pass without the dead surfaces.
    - COMMAND: rg -n "takeFullSnapshot|transport\.rotate|kind: 'load'|'load' \| 'push'" packages/logfire-session-replay/src
    - EXPECTED: No dead production/type declaration remains; unrelated native load tests may remain by name.

Task 5: Publish one stable documentation and Changeset contract
  MODIFY packages/logfire-browser/src/browserSession.ts:
    - Clarify idleTimeoutMs type docs: replay startup initializes/touches the session once before lazy loading; subsequent replay events only peek and do not extend inactivity; span starts are the ongoing automatic activity; explicit getBrowserSessionId access touches the session.
  MODIFY packages/logfire-browser/README.md and docs/packages/browser.md:
    - Keep sessionReplay top-level and add a configure result example using cleanup.sessionReplay.flush/stop plus full cleanup.
    - State synchronous property availability, conservative lazy/failure state, replay-only idempotent stop, full-cleanup distinction, and getBrowserSessionId ownership.
    - Document exact Web Vitals log span type and metrics-startup spans-only degradation diagnostic/no unauthenticated fallback.
    - Define inactivity precisely: replay startup initializes/touches the session once before lazy loading, subsequent replay events only peek and do not refresh it, span starts are the ongoing automatic activity, and the explicit getter touches. Retain verbatim-in-meaning R3 async credential/page-freeze/shared-quota caveat and R5 privacy defaults.
  CREATE .changeset/browser-optional-feature-api.md:
    - Add focused patch entries for @pydantic/logfire-browser and @pydantic/logfire-session-replay covering the facade/degradation/span semantics and dead pre-stable navigation kind cleanup.
  ENABLES: CX-8c, parent CX-8, and R8.
  VERIFY:
    - COMMAND: vp fmt --check packages/logfire-browser/README.md docs/packages/browser.md packages/logfire-browser/src/browserSession.ts .changeset/browser-optional-feature-api.md
    - EXPECTED: Public types/docs/release note are formatted and mutually consistent.
    - COMMAND: rg -n "sessionReplay|span inactivity|replay start|initial|peek|do not refresh|logfire.span_type|span reporting only|asynchronous|page freeze|termination" packages/logfire-browser/src/browserSession.ts packages/logfire-browser/README.md docs/packages/browser.md .changeset/browser-optional-feature-api.md
    - EXPECTED: Source public comments and both guides state the initial replay-start touch, subsequent replay peek/non-refresh, ongoing span activity, and getter touch; every other settled public term and caveat is present with no rum.sessionReplay placement.

Task 6: Build and run the minimal public consumer for parent CX-8
  CREATE packages/logfire-browser/test-fixtures/optional-feature-api/index.html, main.ts, recorder.d.ts, vite.config.ts, verify.mjs, and tsconfig.json as needed:
    - Resolve @pydantic/logfire-browser from built dist output and typecheck against dist/index.d.ts, not source aliases.
    - Compile `const legacy: () => Promise<void> = configure(...)`, call it, and separately use the exported BrowserConfigureHandle/BrowserSessionReplayHandle without getSessionId.
    - Run public configure with no replay, a gated lazy replay, a failing replay load, and sequential replay generations using controlled runtime counters and loopback trace receipts.
    - Require off/false before readiness; ordered early flush then stop; stop identity and one underlying stop; a post-stop manual span and Web Vitals callback while the provider remains active; full cleanup identity/one pass followed by a retained Web Vitals callback with no output; safe failed-start calls; and stale A calls leaving B untouched.
    - Inspect both ESM/CJS built declarations for the callable facade, optional property, exact four-member replay surface, top-level sessionReplay input, and idleTimeoutMs comment covering the initial replay-start touch, subsequent peek/non-refresh, ongoing span activity, and getter touch.
    - Fail on missing/unexpected calls, leaked getSessionId on the facade, generation crossing, page errors, or legacy compile/runtime incompatibility.
  PATTERN: packages/logfire-browser/test-fixtures/provider-lifecycle and privacy-defaults.
  ENABLES: CX-8a, CX-8c and parent CX-8.
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-session-replay#build && vp run @pydantic/logfire-browser#build
    - EXPECTED: Fresh public ESM/CJS/declaration outputs exist.
    - COMMAND: vp dev --config packages/logfire-browser/test-fixtures/optional-feature-api/vite.config.ts --host 127.0.0.1 --port 4179
    - EXPECTED: Loopback built-consumer fixture starts in a managed terminal.
    - COMMAND: agent-browser --session r6-optional-api open http://127.0.0.1:4179/
    - EXPECTED: Fresh browser realm runs only public built imports.
    - COMMAND: agent-browser --session r6-optional-api wait --fn "window.__logfireOptionalFeatureApi?.phase === 'complete'"
    - EXPECTED: Legacy, lazy, failed, stop/full-cleanup, repeated, and A/B cases complete without page error.
    - COMMAND: node packages/logfire-browser/test-fixtures/optional-feature-api/verify.mjs
    - EXPECTED: Exact type, runtime counter, promise identity, span receipt, and generation-ownership evidence passes.
    - COMMAND: agent-browser --session r6-optional-api close
    - EXPECTED: Fixture browser session closes cleanly.

Task 7: Run integrated gates and record R6 evidence
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-session-replay#test && vp run @pydantic/logfire-session-replay#typecheck && vp run @pydantic/logfire-session-replay#build
    - EXPECTED: Replay package remains green after dead-surface cleanup.
    - COMMAND: vp run @pydantic/logfire-browser#test && vp run @pydantic/logfire-browser#typecheck && vp run @pydantic/logfire-browser#build
    - EXPECTED: Browser public/runtime/type contract passes.
    - COMMAND: node_modules/.bin/changeset status --output /tmp/r6-changeset-status.json
    - EXPECTED: Changesets parses all files; browser remains 0.17.0 and replay remains 0.1.0 while the known R8 private null-version defect remains visible.
    - COMMAND: node --input-type=module -e "import {readFileSync} from 'node:fs';const s=JSON.parse(readFileSync('/tmp/r6-changeset-status.json','utf8'));const c=s.changesets.find(({id})=>id==='browser-optional-feature-api');const a=[...(c?.releases??[])].sort((x,y)=>x.name.localeCompare(y.name));const e=[{name:'@pydantic/logfire-browser',type:'patch'},{name:'@pydantic/logfire-session-replay',type:'patch'}].sort((x,y)=>x.name.localeCompare(y.name));if(JSON.stringify(a)!==JSON.stringify(e))process.exit(1)"
    - EXPECTED: The focused R6 Changeset contains exactly the intended browser/replay patch entries.
    - COMMAND: pnpm run check
    - EXPECTED: Complete repository build, format/lint, typecheck, and tests pass.
```

### Integration Points

```yaml
PUBLIC_CONFIG:
  - packages/logfire-browser/src/index.ts — callable handle and top-level sessionReplay input.

REPLAY_PEER:
  - packages/logfire-browser/src/sessionReplay.ts — contained loaded runtime adapted to a generation-scoped public facade.

WEB_VITALS:
  - packages/logfire-browser/src/webVitals.ts — page-lifetime observers route only to the active generation and emit Logfire log spans.

METRICS:
  - packages/logfire-browser/src/browserMetrics.ts — optional recorder/export path; absence degrades spans only, header failure remains a failed authenticated export.

SESSION:
  - BrowserSessionSpanProcessor -> BrowserSessionManager.touch — existing span-based inactivity source.

PUBLIC_EVIDENCE:
  - test-fixtures/optional-feature-api — built declarations/runtime, loopback receipts, and sequential-generation counters.

RELEASE:
  - .changeset/browser-optional-feature-api.md — focused browser/replay pre-stable contract entry consumed by R8.
```

## Validation

```bash
vp run @pydantic/logfire-session-replay#test
vp run @pydantic/logfire-session-replay#typecheck
vp run @pydantic/logfire-session-replay#build
vp run @pydantic/logfire-browser#test
vp run @pydantic/logfire-browser#typecheck
vp run @pydantic/logfire-browser#build
vp fmt --check packages/logfire-session-replay packages/logfire-browser docs/packages/browser.md .changeset/browser-optional-feature-api.md plans/028-browser-optional-feature-api.md
node_modules/.bin/changeset status --output /tmp/r6-changeset-status.json
pnpm run check
```

The executor must also run Task 6's exact built-consumer browser scenario. Source
unit tests or inspection of `index.ts` cannot substitute for parent `CX-8`'s
public type/runtime boundary. If built ESM/CJS declarations or the browser
fixture cannot run, grade affected scenarios `UNVERIFIED` and do not mark R6
verified.

### Required Test Coverage

- [x] Legacy callable cleanup assignment, invocation, repeated/concurrent
      promise identity, and unchanged full-cleanup ordering/failure behavior.
- [x] `sessionReplay` absent when unconfigured and synchronously present when
      configured, with exact public type members and no session id.
- [x] Calls before lazy readiness, startup failure, live/off getters, early
      flush/stop ordering, stop-before-later-flush behavior, repeated stop, and
      full cleanup racing/joining stop.
- [x] Replay-only stop leaves trace/Web Vitals generation active, proven by a
      Web Vitals callback as well as a manual span; a retained callback after
      later full cleanup is silent and cleanup stops everything once.
- [x] Sequential A/B ownership and stale A facade no-op after A cleanup.
- [x] Metrics startup failure emits the exact spans-only diagnostic, passes no
      metric recorder, and still emits the Web Vital span.
- [x] Installed metric exporter synchronous header throw and asynchronous
      header rejection each send zero requests and never fall back to empty
      headers.
- [x] Exact `logfire.span_type = 'log'` on every Web Vital point span.
- [x] Late callbacks after shutdown produce no span, metric, or false missing
      tracer diagnostic; the retained observer routes correctly to B.
- [x] Initial replay-start touch, subsequent span-based inactivity/getter-touch
      semantics, and async replay credential unload caveat are consistent in
      public comments, README, and browser docs.
- [x] Dead rotate/snapshot/load-kind surfaces are absent while public session
      rotation, rrweb checkout, and navigation capture remain green.
- [x] Focused Changeset exact package entries and known R8 baseline separation.

### Consumer Verification Plan

| Scenario | Exercise                                                                                                                                                                                         | Expected observable evidence                                                                                                                                                                                                                        | Environment and prerequisites                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `CX-8a`  | Build browser/replay, typecheck and run the port-4179 minimal consumer through legacy/no-replay, gated replay, failed replay, replay-only stop/full cleanup, repeated calls, and A/B generations | Legacy callable compiles/runs; exact facade declaration/runtime; conservative states; ordered calls; one stop/cleanup; trace remains after replay stop; failed startup safe; stale A cannot touch B                                                 | Node 24.14.1, pnpm 11.5.2, built ESM/CJS declarations, Vite+ loopback, isolated agent-browser, no credentials |
| `CX-8b`  | Public configure with controlled callbacks and metrics startup/header failures; emit before replay stop, after replay stop, and after full cleanup                                               | Exact Logfire log spans before and after replay-only stop; selected spans-only diagnostic; zero requests for synchronous header throw and asynchronous rejection; no output/false diagnostic after full cleanup; later generation receives callback | Browser integration tests with real span exporter and installed OTel metrics exporter request recorder        |
| `CX-8c`  | Inspect built declarations, minimal consumer source, README, browser docs, and focused Changeset                                                                                                 | One top-level, callable, generation-scoped API; exact inactivity, degradation, span-type, privacy, credential/unload, and replay-only/full-cleanup wording; exact browser/replay patch entry                                                        | Fresh build plus formatted repository documentation and Changesets 2.30.0                                     |

## Unknowns & Risks

- Public methods that wait for lazy startup can retain a promise until a
  consumer-supplied `load()` settles. This follows the settled D3 contract and
  full cleanup already has the same wait; the fixture must make the wait
  observable rather than adding an undocumented timeout.
- Removing public navigation kind `'load'` is a pre-stable type narrowing. It is
  intentional because no runtime emits it and the focused replay Changeset must
  state the correction; pause if a real supported consumer appears.
- A metrics exporter can fail after successful metrics startup (including
  rejected headers). That does not retroactively remove the recorder; the
  security promise is zero unauthenticated request, while span reporting remains
  independent.
- Page-lifetime Web Vitals observers retain callbacks by design. Ownership
  bookkeeping must prevent an older handle from clearing B, following the
  existing current-tracer/current-recorder identity checks.

**Confidence: 9/10** for one-pass implementation success. The public shape and
race semantics were conclusively spiked, live source exposes bounded integration
points, and direct built-consumer plus focused exporter/callback evidence covers
the remaining implementation risk.

## Verification Record

- **Verified**: 2026-07-13 from source baseline `aae49f6`, preserving the
  uncommitted roadmap, PRP, and Spike 05 decision record.
- **Focused package gates**: browser 151/151 tests and replay 143/143 tests
  passed; both packages built and typechecked through the integrated gate.
- **Public degradation evidence**: public `configure()` with a real in-memory
  span exporter preserved exact `web_vital.fcp` Logfire log spans after metrics
  startup failure. Real browser-metrics startup with synchronous and
  asynchronous credential-header failure sent zero requests.
- **Direct consumer evidence**: the built minimal-consumer fixture proved the
  legacy callable cleanup contract, exact ESM/CJS public declarations, lazy and
  failed states, ordered early operations, promise identity, replay-only stop,
  full cleanup, live `buffer`/`true` and stopped `off`/`false` getters, and stale
  generation isolation.
- **Release metadata**: Changesets selected exactly patch releases for
  `@pydantic/logfire-browser` and `@pydantic/logfire-session-replay`; the known
  R8 Next.js example baseline remains separate.
- **Integrated gate**: `pnpm run check` passed formatting, lint, all package
  builds and typechecks, and all package tests.
- **Independent Standard review**: the first read-only execution review found
  two evidence gaps. After adding direct public metrics/header integration and
  live replay getter assertions to the built fixture, re-review reported READY
  with no remaining findings.
