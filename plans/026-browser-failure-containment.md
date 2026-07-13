# PRP: Browser Optional-Feature Failure Containment and Replay Backpressure

## Goal

Make optional replay and browser RUM failure paths host-safe and bounded. Throwing
or rejecting callbacks, reporters, replay-module getters, timers, rrweb callbacks,
and metric-header resolvers must not escape into application control flow or become
unhandled rejections. Sampled replay buffers and session-activity persistence must
remain bounded without losing the full-snapshot anchor required for playback.

## Why

- Browser applications should not crash or accumulate unhandled rejections because
  an optional replay callback, error reporter, or lazy module is broken.
- Buffer-mode replay currently grows without a cap, and every rrweb event or span
  start performs synchronous session-storage work.
- Stable release acceptance scenario `CX-4` requires contained optional failures,
  authenticated export semantics, and bounded runtime behavior.

## Success Criteria

- [x] Throwing `getSessionId`, `getTraceContext`, `getDistinctId`, callback-backed
      reporters, and hostile replay-state getters are contained at every timer, rrweb,
      span-start, and export boundary; no host exception or unhandled rejection leaks.
- [x] A failed metrics-header resolver is a failed authenticated export: it is
      diagnosed/contained and never retried or sent with empty headers.
- [x] Buffer-mode replay obeys the documented `maxBufferBytes` policy while
      retaining the newest full-snapshot anchor; post-rotation work cannot flush an old
      runtime.
- [x] Replay and browser session managers update in-memory activity immediately,
      bound storage writes with a deterministic debounce, and retain current expiry
      behavior even when storage is unavailable or throws.
- [x] Empty replay/metrics URL validation is consistent at the public browser
      configuration boundary, and exact regression tests cover all touched behavior.

## Roadmap Context

- **Parent roadmap**: `plans/roadmaps/001-browser-rum-release-remediation.md`
- **Roadmap step**: `R4` — contain optional-feature failures and replay backpressure.
- **Satisfied dependencies**: None. R4 is intentionally independent of the blocked
  privacy/API decisions; the current baseline includes verified R1–R3 changes in
  commit `6e07649`.
- **Inherited decisions and invariants**: preserve the replay envelope, sequence
  persistence, authenticated gzip uploads, R3's 48,000-byte lifecycle budget and
  one-attempt unload semantics, proxy-first deployment guidance, application-owned
  OpenTelemetry globals, and documented synchronous configuration errors.
- **Contract produced for later steps**: a host-safe optional-feature boundary and
  bounded replay/session-runtime contract consumed by R6 and the final `CX-4`
  integration gate.

## Consumer Contract

### Consumer and Public Boundary

- **Consumer(s)**: browser SDK integrators, standalone replay integrators, host
  applications using OpenTelemetry, and applications supplying replay/metric
  callbacks.
- **Public or supported boundary**: `logfire.configure(...)`,
  `startSessionReplay(...)`, returned replay handles, browser span creation,
  replay requests, metric export requests, and documented replay configuration.
- **Entry point and prerequisites**: a browser-like `window`/`document`, a valid
  replay or metrics proxy URL, optional lazy replay module, and the existing
  public callback options. Tests may inject clocks, storage, fetch, exporters, and
  loaded modules through existing test seams.
- **Current observable behavior**: callback failures can escape session/trace
  timers and rrweb callbacks; replay state getters can break every `startSpan()`;
  buffer mode has no byte cap; activity touches synchronously read/write storage;
  browser replay URL validation occurs only after asynchronous startup; metric
  header failures have no direct regression coverage.
- **Observable promise**: optional failures are diagnosed and skipped or treated as
  failed exports without escaping the host; replay remains authenticated; memory
  and storage work are bounded; invalid configuration fails at the documented
  public boundary.
- **Must remain compatible with**: existing option and handle shapes, rrweb replay
  envelope/version and sequence semantics, proxy-first authentication, current
  sampling promotion behavior, and intentional synchronous errors for invalid
  standalone configuration or initial startup failures.
- **Not claimed**: guaranteed delivery after page termination, support for making
  sync callback options asynchronous, privacy-default changes, metrics-only
  degradation decisions, or a new public replay lifecycle API.

The intentional synchronous-throw inventory is: controller-lease conflicts,
malformed/empty public configuration, and recorder or lazy-module startup failures.
All optional callback failures—including initial session lookup, trace/distinct-id
callbacks, error reporters, and replay-runtime getters—are contained with the
fallbacks below. Async `flush()`/`stop()` methods report optional failures and settle
without creating an unhandled rejection; existing cleanup ordering and idempotence
remain unchanged.

### Acceptance Scenarios

| ID     | Given                                                                                                                                          | When                                                                                                   | Then                                                                                                                                                                                | Evidence surface                                                                                                          | Required evidence                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `CX-1` | Standalone replay has throwing session/trace/distinct-id callbacks and a throwing or rejecting reporter                                        | Session polling, rrweb emission, an error/rejection event, and an ordinary flush invoke them           | The host receives no escaped exception or unhandled rejection; the affected observation is skipped, the upload remains authenticated when possible, and the reporter cannot recurse | Public `startSessionReplay()` plus fake timers, rrweb seam, fetch, and rejection tracking                                 | DIRECT REQUIRED — callback containment is the public behavior                                   |
| `CX-2` | A sampled session receives a full snapshot and enough incremental events to exceed `maxBufferBytes`, then rotates while an error callback runs | Events arrive, the cap is crossed, and the old runtime is deactivated during custom-event handling     | The buffer follows the documented anchor-preserving cap, no old-session promotion/flush starts after deactivation, and sequence/session identity remain observable in uploads       | `ReplayTransport` through `startSessionReplay()` plus decoded receipts and a deterministic recorder seam                  | DIRECT REQUIRED — playback anchor and old-session behavior must be observed                     |
| `CX-3` | Replay and browser session managers use counting storage with a fake clock, and storage may throw                                              | A burst of rrweb events/span starts touches the session, then time advances across idle/max boundaries | Storage writes are bounded by the debounce, in-memory `lastActivityAt` remains current for expiry, and storage failure does not break identity or span creation                     | Public replay callbacks and `BrowserSessionSpanProcessor` with fake clock/counting or throwing storage                    | DIRECT REQUIRED — bounded I/O and expiry are the contract                                       |
| `CX-4` | The loaded replay module exposes getters that throw; the browser metrics header resolver throws or rejects                                     | An application starts spans and the configured periodic metric reader reaches an export                | Span creation continues without replay state attributes; failed metric export is contained and no request is sent without the required headers                                      | Public browser `configure()`, real span start, configured reader timer/request recorder, and unhandled-rejection tracking | DIRECT REQUIRED — host safety and auth failure semantics cannot be inferred from unit internals |
| `CX-5` | Browser configuration supplies an empty replay or metrics URL, or a replay URL that is malformed, root, query-bearing, or fragment-bearing     | `configure()` is called                                                                                | Invalid replay/empty-URL cases fail consistently at configuration time with the established error shape; valid non-root replay URLs proceed to startup                              | Public `configure()` and existing telemetry URL tests                                                                     | DIRECT REQUIRED — configuration timing is observable                                            |

## Research Summary

### Vetted Repository Findings

- `packages/logfire-session-replay/src/index.ts:61-69,114-119,173-205` — session
  and trace callbacks are invoked directly at startup, in an interval, and from
  rrweb emission — **PRP impact**: add guarded callback boundaries and tests for
  each public/timer path; preserve deliberate synchronous configuration/startup
  errors while falling back to the internal session id when an optional callback
  fails.
- `packages/logfire-session-replay/src/index.ts:212-228,254-257` — error custom
  events can deactivate/rotate a runtime before promotion logic re-checks state,
  and rejection messages are not coerced — **PRP impact**: re-check `active` after
  recorder calls and normalize non-string messages before creating typed payloads.
- `packages/logfire-session-replay/src/transport.ts:72-84` — buffer mode resets on
  full snapshots but only enforces `maxBufferBytes` in full mode — **PRP impact**:
  implement an anchor-preserving cap and document its drop behavior.
- `packages/logfire-session-replay/src/session.ts:30-47,67-97` — every touch reads
  and writes session storage synchronously while memory state is otherwise enough
  for current expiry — **PRP impact**: debounce persistence, use memory for hot
  reads, and keep storage failure best-effort.
- `packages/logfire-browser/src/browserSession.ts:130-145,176-219` and
  `packages/logfire-browser/src/BrowserSessionSpanProcessor.ts:49-58` — browser
  spans touch storage on every start and replay state is read without a guard —
  **PRP impact**: apply the same bounded activity contract and isolate getter
  failures from span creation.
- `packages/logfire-session-replay/src/capture.ts:332-342` — `safeEmit` catches
  emitter errors but can synchronously re-enter `onError` through captured console
  output — **PRP impact**: add a per-capture reporter reentrancy guard and suppress
  rejected reporter promises.
- `packages/logfire-session-replay/src/transport.ts:358-364`,
  `packages/logfire-browser/src/sessionReplay.ts:244-250` — current error-report
  guards catch synchronous throws only — **PRP impact**: attach rejection handlers
  to thenable reporter results without changing the public sync callback type.
- `packages/logfire-browser/src/browserMetrics.ts:220-230` — metric headers are
  resolved inside the OTLP exporter and currently use no explicit empty-header
  fallback on resolver failure — **PRP impact**: add sync-throw and async-reject
  exporter-boundary tests and preserve failed-export/no-unauthenticated-request
  semantics.
- `packages/logfire-browser/src/index.ts:441-447,227-236`,
  `packages/logfire-browser/src/telemetryUrls.ts:26-44` — metrics empty URL is
  checked during configuration, while replay validation happens during async
  startup — **PRP impact**: validate replay input at `configure()` while retaining
  valid browser-relative URL resolution and existing root/query/fragment rules.
- `packages/logfire-session-replay/README.md:167-181` — sampling and final flush
  behavior are documented but buffer-drop behavior is not — **PRP impact**: add the
  bounded anchor policy without changing sampling promotion semantics; document
  that the cap is the UTF-8 byte sum of event JSON (before envelope/compression),
  not compressed upload size.

### External Constraints

- `@opentelemetry/exporter-metrics-otlp-http` as installed in the workspace — the
  fetch transport awaits async headers inside its failed-export path; a resolver
  throw/rejection must remain a failed export, not be replaced with `{}`. The
  implementation must verify this against the installed dependency during tests,
  not assume a network request was attempted.

### Settled Decisions and Rejected Alternatives

- **Decision**: guard optional callbacks at their invocation boundary, report once
  through a reentrancy-safe reporter, and skip only the affected observation/event.
  Keep invalid configuration and recorder/startup failures synchronous, but do not
  let an optional session/trace/distinct-id callback failure escape even on the
  initial public call; use the last-known session id or static distinct id fallback —
  **Evidence/rationale**: combined review B10 allows documented synchronous errors
  only, and no callback-throw behavior is documented.
- **Intentional synchronous throws**: malformed/empty public configuration and
  recorder/module startup failures remain synchronous for standalone startup;
  `getSessionId`, `getTraceContext`, `getDistinctId`, and error reporters are
  optional callbacks and never intentionally escape, including during initial
  observation.
- **Decision**: retain the last successfully observed session id when an external
  `getSessionId` throws. Do not rotate to an internal id and then rotate back; report
  the failure and skip only the current observation. A successful callback result
  updates the last-known id normally. A throwing `getDistinctId` reports and uses
  the static `distinctId` value (or omits the field when it is empty) rather than
  failing the flush.
- **Decision**: returned replay-handle getters use the same last-known session id
  and report-and-fallback `mode: 'off'`/`recording: false` values when a loaded
  runtime getter throws. `flush()` and `stop()` retain their awaitable/idempotent
  shapes, report optional failures, and settle without an unhandled rejection.
- **Decision**: in buffer mode, retain the newest full snapshot and the earliest
  contiguous following events that fit `maxBufferBytes`; once the cap is reached,
  drop later incrementals until a later full snapshot resets the buffer. Drop
  incrementals before any anchor and incrementals that individually exceed the cap.
  If one full snapshot alone exceeds the cap, retain that single anchor as an
  explicit one-event exception until a later snapshot replaces it —
  **Evidence/rationale**: rrweb playback requires a full-snapshot anchor and
  incremental events depend on prior state, so retaining a newest tail would be
  unplayable even if it fit the byte cap.
- **Decision**: debounce storage writes with an exact 1,000 ms trailing timer. Every
  touch updates memory immediately and coalesces to one pending write; create/reset
  writes immediately. Read storage on initial load or after in-memory expiry, not for
  every hot touch. Replay stop and browser-session cleanup synchronously flush and
  cancel a pending write —
  **Evidence/rationale**: session storage is best-effort and page-local; expiry must
  follow current in-memory activity.
- **Decision**: do not broaden sync callback options to `MaybePromise`; contain
  runtime thenables only where callbacks already return promises (`onError`, metric
  headers, token/transport paths) and attach rejection handlers — **Evidence/rationale**:
  current public types and compatibility promise.
- **Rejected**: fallback to `{}` metric headers — **Reason**: it can turn a
  credential failure into an unauthenticated export; X1 is explicitly declined in
  the combined review.
- **Rejected**: global teardown or a new replay handle/API — **Reason**: provider
  ownership is R2 and public optional-feature placement is R6.

### Spike Evidence

- `None needed` — all R4 questions are answerable from current code, existing
  patterns, and focused public-boundary tests. The transport/CSP and lifecycle
  spikes already completed for R3/R2 are inherited rather than reopened.

### Validation Baseline

| Command                                             | Status                 | Observed or expected result                                                         |
| --------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------- |
| `vp run @pydantic/logfire-session-replay#test`      | Verified               | 8 files, 128 tests passed on `6e07649`                                              |
| `vp run @pydantic/logfire-browser#test`             | Verified               | 11 files, 136 tests passed on `6e07649`                                             |
| `vp run @pydantic/logfire-session-replay#typecheck` | Discovered but not run | Required after implementation                                                       |
| `vp run @pydantic/logfire-browser#typecheck`        | Discovered but not run | Required after implementation                                                       |
| `pnpm run check`                                    | Verified               | Passed for the committed R1–R3 baseline before this PRP; rerun after implementation |

### Research Coverage

- **Depth**: Deep — cross-package callback, storage, replay transport, browser span,
  metric-export, documentation, and public-boundary paths were inspected.
- **Inspected**: R4 roadmap/report findings; standalone replay index, transport,
  recorder, capture, session manager, types, tests and README; browser configure,
  session manager, span processor, session replay bridge, metrics exporter, URL
  validation, tests and docs; recent history and package commands.
- **Not inspected**: R5 privacy defaults, R6 API/metrics degradation decisions, R7
  proxy/example behavior, R8 release simulation, Platform implementation, and
  browser-engine divergences; those are separate roadmap steps.
- **Research confidence**: HIGH for failure paths and test surfaces; MEDIUM for the
  exact single-oversized-snapshot edge, which is explicitly specified and tested in
  this PRP.

## Execution Contract

- **Planned at commit**: `6e07649`
- **Planning baseline**: clean working tree; preserve all existing files and the
  committed R1–R3 implementation.

### Expected Changes

- `packages/logfire-session-replay/src/index.ts` — guarded session/trace/distinct-id
  callback calls, active re-check, rejection coercion, async-safe reporting.
- `packages/logfire-session-replay/src/transport.ts` — bounded buffer trimming and
  shared reporting/rejection containment where required.
- `packages/logfire-session-replay/src/session.ts` — memory-first session access and
  debounced persistence.
- `packages/logfire-session-replay/src/capture.ts` — reporter reentrancy guard and
  thenable rejection suppression.
- `packages/logfire-browser/src/browserSession.ts` — matching bounded activity
  persistence.
- `packages/logfire-browser/src/BrowserSessionSpanProcessor.ts` and
  `packages/logfire-browser/src/sessionReplay.ts` — replay-state getter isolation
  and safe bridge reporting.
- `packages/logfire-browser/src/browserMetrics.ts` and `src/index.ts` — explicit
  failed-header export characterization and configuration-time URL validation.
- `packages/logfire-browser/src/browserConfigure.integration.test.ts` — public
  `configure()`/real-provider span evidence with a hostile lazy replay module.
- Focused tests beside each touched module, plus any minimal shared test helper
  required for deterministic fake clocks/counting storage.
- `packages/logfire-session-replay/README.md` and, only if the public behavior is
  surfaced there, browser documentation describing bounded buffer retention and
  host-safe failure semantics.

### Explicitly Out of Scope

- Privacy defaults, URL redaction policy, console/navigation data policy, and the
  Platform handoff (R5).
- Metrics startup degradation, Web Vitals span type, inactivity documentation, and
  public replay-handle/API placement (R6).
- Provider ownership/reconfiguration (R2), unload/CSP/retry transport behavior
  already delivered by R3, proxies/examples (R7), and release metadata (R8).
- New asynchronous callback types, new public options, replay wire/schema changes,
  or a change from proxy-first authentication.
- The obsolete `vite-plus/test` import cleanup disposition.

### Scope Expansion Rule

Additional files are allowed only when needed to preserve the same public failure
and backpressure contract. Record each added path and rationale in Execution Notes.
Pause if implementation requires a new public API, changes replay schema/auth
semantics, or requires a cross-roadmap product decision.

### Pause and Reassess If

- Strict `maxBufferBytes` cannot be reconciled with retaining a valid full-snapshot
  anchor without changing the replay envelope or adding a public policy option.
- The installed metrics exporter sends a request after header resolution rejects,
  or the only containment path would retry without caller-provided credentials.
- Debouncing would make session expiry observable from the public API differ from
  current in-memory behavior, or storage failure would require a new error contract.
- A supposedly optional callback is found to be intentionally synchronous and
  documented as throwing for a valid public use case.
- A real browser acceptance test requires R5 privacy, R6 API, or R7 proxy changes.

## Context

### Key Files

- `packages/logfire-session-replay/src/index.ts` — public replay lifecycle, timer,
  rrweb, error, and callback boundaries.
- `packages/logfire-session-replay/src/transport.ts` — event buffer, upload,
  authentication, distinct-id callback, and error reporting.
- `packages/logfire-session-replay/src/session.ts` — standalone session identity,
  expiry, and storage fallback.
- `packages/logfire-session-replay/src/capture.ts` — console/network wrappers and
  the canonical `safeEmit` containment pattern.
- `packages/logfire-browser/src/browserSession.ts` — browser session persistence
  and public session-id access.
- `packages/logfire-browser/src/BrowserSessionSpanProcessor.ts` — span-start
  touch/state-attribute boundary.
- `packages/logfire-browser/src/sessionReplay.ts` — optional module bridge and
  replay-state getters.
- `packages/logfire-browser/src/browserMetrics.ts` — OTLP metric exporter and
  dynamic header resolver.
- `packages/logfire-browser/src/index.ts` and `telemetryUrls.ts` — configuration
  normalization and current URL validation timing.

### Gotchas

- `getSessionId`, `getTraceContext`, and `getDistinctId` are typed synchronous
  callbacks; contain throws without silently turning them into supported async APIs.
- An incremental-only rrweb buffer is not a playable replay; cap trimming must keep
  the latest full snapshot anchor.
- `onError` callbacks can themselves log through a patched console. Reentrancy must
  be guarded before invoking the reporter, and rejected thenables must be consumed.
- Session storage failures are intentionally best-effort. Do not make storage
  availability a prerequisite for a session id or span.
- R3 already owns authenticated lifecycle delivery and a 48,000-byte budget; do not
  alter those semantics while implementing R4.

## Implementation Blueprint

### Tasks

```yaml
Task 1: Harden standalone replay callback and error boundaries
  MODIFY packages/logfire-session-replay/src/index.ts:
    - Guard session, trace, distinct-id, rrweb emit, and recorder custom-event boundaries.
    - Preserve lease/configuration and recorder/startup throws, but report optional callback failures and fall back to the last-known session id or static distinct id even on the initial call.
    - Re-check active after recorder.addCustomEvent before sampling promotion or flush.
    - Coerce rejection messages with String() while preserving stack data when present.
    - Make reporter invocation consume rejected thenables and prevent recursive reporting.
  MODIFY packages/logfire-session-replay/src/transport.ts:
    - Guard getDistinctId during envelope creation, falling back to the static id or omitting it without leaking a rejected flush.
  MODIFY packages/logfire-session-replay/src/index.test.ts:
    - Add timer, rrweb, rejection, rotation-race, distinct-id, handle-getter, flush/stop, and async-reporter tests with unhandled-rejection tracking.
  ENABLES: CX-1, CX-2
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-session-replay#test
    - EXPECTED: all existing tests plus exact new containment assertions pass.

Task 2: Bound replay buffer mode without invalidating playback
  MODIFY packages/logfire-session-replay/src/transport.ts:
    - Trim buffer-mode events when the estimated UTF-8 event JSON total exceeds maxBufferBytes.
    - Drop incremental events before any anchor and incremental events that individually exceed the cap.
    - Retain the newest FullSnapshot and the earliest contiguous fitting following events; drop later incrementals until a new snapshot; retain an oversized anchor alone as the explicit single-event exception.
    - Keep full-mode auto-flush, sequence persistence, envelope shape, and R3 lifecycle delivery unchanged.
  MODIFY packages/logfire-session-replay/src/transport.test.ts:
    - Prove incremental-only, oversized-incremental, multiple-snapshot, cap, anchor retention, oversized-anchor behavior, deterministic earliest-prefix trimming, and decoded event ordering.
  MODIFY packages/logfire-session-replay/README.md:
    - Document bounded buffer retention, deterministic earliest-prefix trimming, the anchor exception, and the UTF-8 event-JSON byte basis alongside sampling behavior.
  ENABLES: CX-2
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-session-replay#test
    - EXPECTED: bounded-buffer tests pass and decoded receipts never contain pre-anchor incrementals.

Task 3: Debounce standalone and browser session persistence
  MODIFY packages/logfire-session-replay/src/session.ts:
    - Keep an in-memory session hot path and update lastActivityAt immediately.
    - Debounce sessionStorage writes on touches with an exact 1,000 ms trailing timer; coalesce bursts and flush/cancel pending writes on stop.
    - Preserve immediate creation/reset persistence and silent storage fallback.
  MODIFY packages/logfire-browser/src/browserSession.ts:
    - Apply the same memory-first expiry and debounced-touch write policy, flushing/cancelling pending writes when the configured manager is cleared.
    - Ensure public session-id/span paths continue working with null or throwing storage.
  MODIFY packages/logfire-session-replay/src/session.test.ts and packages/logfire-browser/src/browserSession.test.ts:
    - Add fake-clock counting-storage burst tests, exact trailing/coalescing assertions, cleanup flush/cancellation, expiry tests, and throwing-storage continuity tests.
  ENABLES: CX-3
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-session-replay#test && vp run @pydantic/logfire-browser#test
    - EXPECTED: write counts stay within the debounce bound while expiry follows current memory activity.

Task 4: Isolate optional replay state and capture reentrancy
  MODIFY packages/logfire-session-replay/src/capture.ts:
    - Add a per-capture reporter reentrancy guard around safeEmit/onError.
    - Consume rejected reporter thenables without changing callback types.
  MODIFY packages/logfire-browser/src/sessionReplay.ts and BrowserSessionSpanProcessor.ts:
    - Guard replay runtime mode/recording/getSessionId access and async flush/stop failures, returning safe last-known/off values and continuing span creation when a getter throws.
    - Preserve truthful active attributes for healthy runtimes.
  MODIFY packages/logfire-session-replay/src/capture.test.ts, packages/logfire-browser/src/sessionReplay.test.ts, BrowserSessionSpanProcessor.test.ts, and packages/logfire-browser/src/browserConfigure.integration.test.ts:
    - Add recursive console/onError, throwing getter, healthy-state, browser onError rejection, and public configure + real provider span regression tests.
  ENABLES: CX-1, CX-4
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-session-replay#test && vp run @pydantic/logfire-browser#test
    - EXPECTED: no recursive stack growth, no unhandled rejection, and normal state attributes remain exact.

Task 5: Contain metric-header failures and align URL validation
  MODIFY packages/logfire-browser/src/browserMetrics.ts:
    - Preserve caller headers and let resolver failure remain a failed export; never synthesize unauthenticated headers.
    - Add diagnostic/containment coverage at the installed exporter boundary for sync throws and async rejection; assert the failure reaches the configured diagnostic/onError path, use a request recorder, and drive the configured periodic reader timer rather than a mocked header callback alone.
  MODIFY packages/logfire-browser/src/index.ts and telemetry URL tests:
    - Validate replay URL input during configure with the existing browser-safe non-root/query/fragment rules.
    - Preserve valid relative/absolute URL normalization and existing metrics validation.
  MODIFY packages/logfire-browser/src/browserMetrics.test.ts and index tests:
    - Assert failed exports produce no request without required credentials and replay/empty-URL validation fails at configure time.
  ENABLES: CX-4, CX-5
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-browser#test && vp run @pydantic/logfire-browser#typecheck
    - EXPECTED: header failure, URL timing, and type checks pass with no unauthenticated request.

Task 6: Cross-package verification and documentation review
  MODIFY docs only when needed to expose the new bounded/host-safe contract:
    - Keep R3 async-credential and lifecycle caveats intact.
    - Ensure replay README/browser docs do not promise unbounded in-memory retention or uncaught optional failures.
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-session-replay#typecheck && vp run @pydantic/logfire-browser#typecheck && pnpm run check
    - EXPECTED: focused typechecks and the complete repository check pass.
```

### Integration Points

- **Replay runtime**: `startSessionReplay()` owns timer/rrweb callback containment;
  `ReplayTransport` owns buffer policy and authenticated upload failures.
- **Browser bridge**: `startBrowserSessionReplay()` and
  `BrowserSessionReplayState` proxy the standalone contract into span processing;
  getter failures must be isolated without changing span provider ownership.
- **Session persistence**: standalone and browser managers share behavior but keep
  their existing storage keys and option types.
- **Metrics exporter**: the OTLP reader remains the exporter owner; R4 only
  characterizes and contains resolver failure, leaving degradation policy to R6.
- **Configuration**: replay validation runs beside existing metrics validation; URL
  matching and R1 self-observation patterns remain unchanged for valid inputs.

## Validation

```bash
vp run @pydantic/logfire-session-replay#test
vp run @pydantic/logfire-session-replay#typecheck
vp run @pydantic/logfire-browser#test
vp run @pydantic/logfire-browser#typecheck
pnpm run check
```

### Required Test Coverage

- [x] Throwing session/trace/distinct-id callbacks at startup, timer, rrweb, and
      flush boundaries; no escaped host exception or unhandled rejection.
- [x] Error reporter that logs through captured console and returns a rejected
      promise; recursion and rejection are contained.
- [x] Error custom event deactivating the runtime before promotion; no old-session
      flush or timer restart.
- [x] Buffer-mode cap with multiple snapshots, incremental trimming, an oversized
      anchor, and exact decoded event order.
- [x] Fake-clock/counting-storage bursts for standalone replay and browser spans;
      bounded writes, immediate memory activity, expiry rotation, and throwing storage.
- [x] Replay-state mode/recording getters that throw; healthy runtime attributes
      remain unchanged and application span creation continues.
- [x] Metric header resolver sync throw and async rejection; zero unauthenticated
      request and contained failed export.
- [x] Empty replay/metrics URLs and malformed/root/query/fragment replay URLs at
      the public configuration boundary.

### Consumer Verification Plan

| Scenario | Exercise                                                                                                                                 | Expected observable evidence                                                                                    | Environment and prerequisites                                            |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `CX-1`   | Start standalone replay with hostile callbacks, dispatch timer/rrweb/error paths, and attach unhandled-rejection tracking                | Host remains alive; affected observations are skipped/reported; no unhandled rejection                          | Vitest browser globals, fake timers, public replay API                   |
| `CX-2`   | Feed large sampled replay events and trigger rotation during custom-event handling; flush through public API                             | Decoded upload retains a playable full-snapshot anchor, respects cap policy, and never uploads old session data | Deterministic recorder/fetch seam and gzip decoder                       |
| `CX-3`   | Burst public replay events and browser span starts using counting storage, advance fake clock, then repeat with throwing storage         | Bounded storage writes, current in-memory expiry, and continued session/span operation                          | Fake clock and injected Storage                                          |
| `CX-4`   | Configure browser with hostile replay getters and metric header resolver; start spans and allow the configured periodic reader to export | Span creation completes without replay attrs on getter failure; failed export has no unauthenticated request    | Public browser API, installed OTel exporter, fake clock/request recorder |
| `CX-5`   | Call public browser configure with each invalid URL class and one valid relative URL                                                     | Invalid cases throw during configuration; valid case reaches normal startup                                     | Browser globals and existing URL test harness                            |

If a real browser is needed to reproduce a host-level unhandled rejection, record
the exact fixture and receipt in the Verification Record; focused public-boundary
tests are the required direct evidence for this child.

## Unknowns & Risks

- A single rrweb FullSnapshot can exceed the configured cap; the explicit anchor
  exception bounds the buffer to one oversized event but may retain more bytes than
  the numeric cap. Confidence: MEDIUM; tests make the behavior visible and the
  policy is reversible without a schema change.
- Debounced persistence can lose the latest storage write on abrupt page termination;
  session identity remains current in memory and storage is already best-effort.
  Confidence: HIGH that this is compatible with the existing contract.
- Exporter failure behavior depends on the installed OTel implementation; tests
  must assert actual request counts against the installed version before claiming
  the no-unauthenticated-request result. Confidence: HIGH after focused execution.
- Invalid configuration and recorder/module startup throws remain synchronous;
  optional callback failures, including the initial `getSessionId` lookup, are
  contained with the fallback specified above. If documentation or tests establish
  a deliberate callback-throw contract, pause rather than silently change it.

**Confidence: 8/10** for one-pass implementation success.

## Execution Notes

### Scope Expansions

- `packages/logfire-browser/src/browserMetrics.integration.test.ts` — added a
  real installed-exporter boundary test so rejected metric headers are validated
  against actual request behavior, not only the mocked unit exporter.

### Deviations

- None.

### Unresolved Risks

- None; the oversized full-snapshot exception is explicit, documented, and covered
  by focused tests.

## Verification Record

### Consumer Acceptance

| Scenario | Grade             | Evidence                                                                                                                                                       | Limitations                                                                         |
| -------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `CX-1`   | DIRECTLY VERIFIED | Standalone replay tests: throwing session/trace/distinct-id paths, recursive console reporter, rejection tracking, and handle settlement; replay suite 136/136 | No real page-freeze fixture was needed for this host-boundary contract              |
| `CX-2`   | DIRECTLY VERIFIED | Transport/index tests: anchor-preserving cap, oversized event handling, active re-check, decoded uploads and rotation; replay suite 136/136                    | Deterministic recorder/fetch seam rather than a live rrweb page                     |
| `CX-3`   | DIRECTLY VERIFIED | Fake-clock/counting-storage tests for both managers, expiry and throwing storage; browser suite 142/142                                                        | Storage is intentionally best-effort on abrupt termination                          |
| `CX-4`   | DIRECTLY VERIFIED | Public browser configure/real-provider span test, hostile getter tests, installed metric exporter request-boundary test; browser suite 142/142                 | Exporter test uses a local fetch recorder, not a remote collector                   |
| `CX-5`   | DIRECTLY VERIFIED | Public configure validation tests for empty replay/metrics and malformed/root/query/fragment replay URLs                                                       | Metrics validation remains intentionally limited to its existing empty-URL contract |

### Compliance and Engineering Review

- **PRP compliance**: all five success criteria and required test-coverage items are implemented with no scope deviations.
- **Engineering review**: focused self-review completed; callback identity, authenticated header failure, anchor retention, persistence lifecycle, and public getter boundaries are covered.
- **Final validation**: `vp check`, both package typechecks, both focused suites (replay 136/136; browser 142/142), and root `pnpm run check` passed.
