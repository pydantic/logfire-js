---
repo: /Users/petyo/w/pydantic/logfire-js
---

# PRP 033: Browser RUM normalized routes and bounded session attributes (issues #190 and #191)

## Goal

Add two application-provided, low-cardinality dimensions to the browser RUM
session configuration:

- `getRouteName?: () => string | undefined`, evaluated for each new browser
  span and emitted as `logfire.page.route`.
- `getSessionAttributes?: () => Record<string, string | number | boolean | undefined>`,
  evaluated into a bounded immutable snapshot for each browser session, emitted
  as `logfire.session.<key>` on browser spans, and copied into replay chunk
  metadata as `sessionAttributes`.

The implementation must preserve existing page URL and session identity
attributes, remain failure-contained when consumer callbacks return hostile
runtime values or throw, exclude both new dimensions from Web Vitals metric
labels, and preserve one session-attribute snapshot across reloads and replay
runtime rotation for the same browser session id.

## Why

- Fixes [pydantic/logfire-js#190](https://github.com/pydantic/logfire-js/issues/190):
  raw paths such as `/projects/123` fragment RUM page tables, filters, and Web
  Vitals drilldown; applications need an explicit stable route template such as
  `/projects/:project_id`.
- Fixes [pydantic/logfire-js#191](https://github.com/pydantic/logfire-js/issues/191):
  operators need a deliberately small set of safe session dimensions such as
  account tier, tenant type, experiment variant, or application region on
  traces and replay indexes.
- A bounded SDK contract prevents these features from becoming an arbitrary
  analytics/user-profile channel and keeps metric cardinality unchanged.
- Both features share the browser session public surface and universal
  span-processor propagation path; implementing them together gives one
  coherent RUM-dimensions contract without coupling their distinct lifecycles.

## Success Criteria

- [x] Browser integrators can configure a dynamic normalized route name under
      `rum.session`; every new span receives the current
      `logfire.page.route` while existing page URL attributes remain unchanged
      (CX-1).
- [x] Browser integrators can configure up to 20 safe scalar session
      attributes; every span in that browser session receives the same
      `logfire.session.*` snapshot across reloads, while a new session gets a
      fresh snapshot (CX-2).
- [x] The same bounded snapshot appears in every replay chunk for its session,
      including after replay observes a browser-session rotation (CX-3).
- [x] Invalid keys/values, oversized strings, non-finite numbers, hostile
      runtime return values, and throwing callbacks are omitted or contained
      without stopping tracing or replay (CX-4).
- [x] Web Vitals metrics retain only their existing configured metric
      attributes; neither `logfire.page.route` nor `logfire.session.*` is added
      implicitly (CX-5).
- [x] Public docs and the browser RUM/replay example describe the low-cardinality,
      non-PII contract; minor changesets cover both public packages.

## Assurance

- **Profile**: Deep
- **Rationale**: this is a backward-compatible SDK feature, but it changes a
  material privacy/cardinality boundary by accepting application values and
  forwarding them to both trace telemetry and replay metadata. It also couples
  persisted browser-session state with a separately published replay envelope
  contract. Incorrect validation or snapshot semantics could leak user data,
  create unbounded index cardinality, or make one session inconsistent across
  traces and replay. The work remains one PRP because both packages can be
  changed and validated in one integrated built-browser loop without a
  migration or rollout dependency.

## Consumer Contract

### Consumer and Public Boundary

- **Consumer(s)**: browser SDK integrators configuring RUM; operators filtering
  Logfire traces and replay sessions; the Logfire replay ingest/index pipeline
  consuming chunk metadata; standalone replay integrators using the public
  replay configuration.
- **Public or supported boundary**:
  `@pydantic/logfire-browser`'s `configure({ rum: { session: ... } })` and
  exported `BrowserSessionOptions`; emitted OpenTelemetry span attributes;
  `@pydantic/logfire-session-replay`'s `SessionReplayConfig`, `ChunkMeta`, and
  version-1 replay JSON envelope.
- **Entry point and prerequisites**: a browser application configures
  `@pydantic/logfire-browser`; replay metadata additionally requires the
  optional `@pydantic/logfire-session-replay` peer and configured
  `sessionReplay`.
- **Current observable behavior**: browser-session spans receive
  `session.id`, `browser.session.id`, `logfire.page.url.full`, and
  `logfire.page.url.path`; replay chunks correlate by the same session id and
  carry fixed metadata such as URLs, trace ids, and optional `distinctId`.
  There is no normalized route or bounded custom session context.
- **Observable promise**: applications can add one current-view route
  dimension and a small immutable session-dimension snapshot to browser spans;
  replay chunks carry the same session snapshot for future index filtering.
- **Must remain compatible with**: `rum.session: true`; existing
  `BrowserSessionOptions`; existing stored session records without custom
  attributes; URL callback/default/disabled behavior; replay envelope version
  1 and consumers that ignore unknown optional metadata fields; standalone
  replay callers that omit the new callback; current replay sampling,
  rotation, delivery, privacy, and cleanup contracts.
- **Not claimed**: automatic route-template inference; soft-navigation Web
  Vitals; route/session dimensions on metrics; arbitrary JSON, arrays, user
  profiles, PII scrubbing, runtime updates to an active session snapshot;
  Platform query/UI/index implementation; a new replay envelope version.

### Acceptance Scenarios

| ID     | Given                                                                                                                                                                                                       | When                                                                                                                                                                                                                    | Then                                                                                                                                                                                                                                                                                           | Exact exercise and prerequisites                                                                                                                                                                                                                                                   | Required evidence                                                                                                       |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `CX-1` | A built browser application configures `rum.session.getRouteName` from application router state, starts at `/projects/123`, and retains default URL attributes                                              | It emits document-load/view, manual duration, manual error point-event, Web Vital, click interaction, fetch, and XHR spans, changes router state to `/settings`, then emits another span                                | Every pre-change span contains `logfire.page.route=/projects/:project_id`; the post-change span contains `/settings`; all retain their existing page URL attributes; an omitted callback emits no route attribute                                                                              | Build both packages; run the loopback `rum-dimensions` Vite fixture; open it in an isolated `agent-browser` session; poll completion; decode captured OTLP trace receipts and run the fixture verifier                                                                             | DIRECT REQUIRED — exercises built public exports and real browser instrumentations                                      |
| `CX-2` | The same public browser configuration returns safe tier, tenant type, experiment, and region values, uses a short deterministic idle timeout, and has a persisted browser session                           | It emits spans, reloads the page in the same tab before the timeout, emits again, then waits past the timeout and emits a final span                                                                                    | Pre-reload and post-reload spans have the same session id and exact `logfire.session.*` snapshot without a second callback evaluation; the post-timeout span has a new session id and a newly evaluated snapshot                                                                               | The built fixture records a callback-generation marker, spans before/after a same-tab reload, and a post-idle-timeout phase through public browser configuration; its verifier decodes trace receipts and stored callback counts                                                   | DIRECT REQUIRED — directly verifies public configuration, tab persistence, and configured rotation                      |
| `CX-3` | Browser replay is enabled with the session attributes from CX-2 and records one chunk before browser-session expiry and one after                                                                           | The fixture flushes replay for the first session, waits past the configured idle timeout, starts a span to rotate the browser session, emits a recorder-visible action, waits for replay observation, and flushes again | Each decoded version-1 replay envelope has `meta.sessionAttributes` exactly matching spans with the same session id; all chunks for one id use one snapshot and the rotated id uses the fresh snapshot                                                                                         | The built fixture captures gzip replay receipts keyed by upload URL/session id; its verifier decodes both envelopes and joins them to OTLP spans by session id                                                                                                                     | DIRECT REQUIRED — crosses the built browser-to-peer bridge and actual replay JSON boundary                              |
| `CX-4` | A browser integrator returns mixed valid and invalid session entries, more than 20 valid entries, invalid route/session runtime types, oversized values, non-finite numbers, or throws from either callback | Browser tracing and replay start and the application emits and flushes telemetry                                                                                                                                        | Instrumentation remains operational; valid session entries are emitted in property order up to 20, invalid entries are absent from spans and replay metadata, and a failed callback contributes no affected attributes without suppressing unrelated session, replay, route, or URL attributes | Build both packages; open the loopback fixture's `/hostile/` route in a second isolated `agent-browser` session; poll completion and run `verify.mjs hostile` to decode both OTLP and replay output; run focused browser/replay table tests for callback/container failure classes | DIRECT REQUIRED — the built scenario crosses the browser-to-real-replay bridge; unit tables exhaust exceptional classes |
| `CX-5` | Web Vitals span and metric reporting are both enabled with route and session callbacks                                                                                                                      | The fixture reports a Web Vital and forces trace and metric export                                                                                                                                                      | The Web Vital span contains route/session dimensions, while the metric point contains only existing default and explicitly configured metric attributes and no `logfire.page.route` or `logfire.session.*` key                                                                                 | Extend the browser metrics/public configure integration harness with in-memory span and metric observations; run the focused browser package test                                                                                                                                  | DIRECT REQUIRED — exercises the public configuration and both telemetry products                                        |

## Research Summary

### Vetted Repository Findings

- `packages/logfire-browser/src/browserSession.ts:10-40,117-204` — session
  options, state persistence, expiry, reset, and current URL callback all live
  in `BrowserSessionManager`; state survives manager instances via
  `sessionStorage`. — **PRP impact**: both callbacks belong under
  `rum.session`; the immutable session snapshot must be stored with the session
  record, while route state must not be snapshotted.
- `packages/logfire-browser/src/BrowserSessionSpanProcessor.ts:49-83` — one
  processor stamps every span created by the configured web provider, including
  Logfire point events and auto-instrumentation spans; consumer URL callback
  errors are already contained. — **PRP impact**: add route/session propagation
  here once, with independent failure boundaries so one callback cannot suppress
  unrelated attributes.
- `packages/logfire-browser/src/index.ts:270-292,511-516` — Web Vitals and
  replay imply a browser session, and the session processor is registered
  before exporters. — **PRP impact**: no new instrumentation-specific hooks are
  needed; existing `rum.session: false` incompatibility remains unchanged.
- `packages/logfire-browser/src/browserMetrics.ts:130-159,206-211` — Web Vitals
  metrics construct an independent attribute set from metric defaults and the
  explicit metric callback. — **PRP impact**: do not pass route/session state
  into this path; retain an exact regression test for the exclusion.
- `packages/logfire-browser/src/sessionReplay.ts:26-48,139-147,180-196` — the
  browser package mirrors the optional peer config, checks assignability, and
  passes browser session id through a hot-path getter. — **PRP impact**: add a
  matching session-attribute getter that only peeks at the already-sanitized
  browser snapshot; preserve lazy-peer loading.
- `packages/logfire-session-replay/src/index.ts:79-129,183-210` — replay creates
  a new active runtime and `ReplayTransport` per observed session id. —
  **PRP impact**: resolve and snapshot standalone session attributes at active
  runtime/transport creation, so replay rotation naturally gets one new
  snapshot and chunk flushes never re-evaluate consumer context.
- `packages/logfire-session-replay/src/transport.ts:177-190` and
  `src/extract.ts:12-83` — every envelope is created centrally and chunk
  metadata is computed in one helper. — **PRP impact**: add one optional
  `sessionAttributes` metadata field without changing delivery, compression, or
  envelope version.
- `packages/logfire-session-replay/src/types.ts:69-87,95-178` — `ChunkMeta`,
  `SessionReplayConfig`, and resolved configuration are public/exported. —
  **PRP impact**: the standalone callback and optional metadata map require a
  minor release and public documentation.
- `packages/logfire-browser/src/browserSession.test.ts`,
  `BrowserSessionSpanProcessor.test.ts`, and `sessionReplay.test.ts` — existing
  canonical tests cover stored-session reuse/rotation, exact span attributes,
  hostile callback containment, and peer config forwarding. — **PRP impact**:
  extend these seams rather than creating alternate session machinery.
- `packages/logfire-session-replay/src/transport.test.ts:51-69,92-138` and
  `index.test.ts` — tests already decode gzip envelopes and exercise dynamic
  session-id rotation. — **PRP impact**: use exact envelope assertions for
  snapshot and rotation behavior.
- `packages/logfire-browser/test-fixtures/privacy-defaults/` — existing
  built-package Vite fixtures load the built optional peer, capture OTLP and
  gzip replay receipts, and verify them through a real browser. — **PRP
  impact**: create a focused sibling fixture using this infrastructure rather
  than treating source-level unit tests as consumer evidence.
- `packages/logfire-browser/README.md:69-109,123-215,222-270` and
  `docs/packages/browser.md:61-101,112-204,213-258` — public docs establish
  tab-scoped session persistence, current page URL behavior, session-bearing
  Web Vitals spans, low-cardinality metric exclusions, and replay/session
  correlation. — **PRP impact**: extend those exact sections and keep package
  README/generated-style docs synchronized.
- `examples/browser-rum-replay/src/main.ts:20-81` already computes route
  templates for URL and metric attributes and configures session replay. —
  **PRP impact**: replace the URL-overloading workaround with
  `getRouteName`, add safe example session dimensions, and keep custom metric
  dimensions explicit.
- GitHub issue #190 has one contributor ownership/API-placement question but no
  maintainer answer; issue #191 has no comments; no open PR references either
  issue as of the planning baseline. — **PRP impact**: implementation is not
  technically blocked, but coordinate ownership before starting.

### External Constraints

- None. The implementation uses existing OpenTelemetry span processor,
  session-storage, rrweb, and JSON envelope patterns; no version-sensitive
  external API change is required.

### Settled Decisions and Rejected Alternatives

- **Decision**: expose both callbacks on `BrowserSessionOptions`, used as
  `rum.session: { getRouteName, getSessionAttributes }`. —
  **Evidence/rationale**: both dimensions require the existing session span
  processor, and replay/Web Vitals already imply that processor.
- **Decision**: evaluate `getRouteName` independently on every span start and
  emit its exact string result, including an empty string; omit only
  `undefined` or hostile non-string runtime values. Catch callback failures and
  retain session, replay, and URL attributes. — **Evidence/rationale**: issue
  #190 defines a current-view callback, not a session snapshot or inferred
  template.
- **Decision**: define session input as
  `Record<string, string | number | boolean | undefined>` and normalized output
  as a plain record of string/number/boolean values. Keys must match
  `^[a-z][a-z0-9_]{0,63}$`; output keeps at most the first 20 valid own
  enumerable string-keyed entries in ECMAScript property order. String values
  may contain at most 200 Unicode code points; numbers must be finite; boolean
  values are accepted; `undefined` and all other runtime types are omitted. —
  **Evidence/rationale**: satisfies issue #191's bounded safe-pattern/scalar
  contract while preventing nested namespace injection and non-finite OTEL
  values.
- **Decision**: at runtime, accept only a non-null non-array object whose
  prototype is exactly `Object.prototype` or `null`; frozen/sealed records are
  valid, while arrays, functions, dates, and class instances are rejected
  wholesale. A proxy is accepted only if prototype/key/value inspection
  succeeds under the same rules. In the browser manager, all callback and
  inspection exceptions are silently contained. In standalone replay,
  callback, prototype, key-enumeration, and individual property-get exceptions
  each invoke `safeReportError(onError, error)` once for that exceptional
  operation; invalid containers, keys, and values are ordinary omissions and
  do not call `onError`. — **Evidence/rationale**: makes hostile runtime input
  deterministic while matching existing replay callback reporting and browser
  host-safety conventions.
- **Decision**: prefix normalized browser span keys with
  `logfire.session.` but store replay `meta.sessionAttributes` with the
  unprefixed application keys. — **Evidence/rationale**: matches the requested
  telemetry namespace while keeping replay JSON useful as a structured map and
  avoiding repeated prefixes.
- **Decision**: persist the normalized snapshot in `BrowserSessionState` and
  never persist the callback or raw input. New sessions evaluate once. A
  legacy valid stored record without the field is lazily hydrated once when a
  callback is configured, while preserving its session id, then rewritten;
  later managers reuse it without callback evaluation. Persist an explicit
  empty record when a configured callback yields no valid entries, so reload
  does not retry it; continue omitting the field when no callback has ever been
  configured. — **Evidence/rationale**: preserves existing sessions across a
  package upgrade without delaying the feature until rotation or changing
  identity mid-session, while distinguishing "evaluated empty" from "not yet
  configured."
- **Decision**: standalone replay exposes the same optional
  `getSessionAttributes` callback, validates it defensively, and snapshots it
  once per active replay session. The browser bridge passes only the browser
  manager's sanitized snapshot getter. — **Evidence/rationale**: the replay
  package is independently consumable and owns the last safety boundary before
  envelope serialization.
- **Decision**: keep replay `CHUNK_ENVELOPE_VERSION = 1` and add optional
  `ChunkMeta.sessionAttributes`. — **Evidence/rationale**: optional metadata is
  additive; the issue requests future index filtering rather than a breaking
  protocol migration.
- **Decision**: do not alter browser metric configuration or implicit
  attribute flow. Route remains available on Web Vitals spans; consumers who
  deliberately need a route metric label continue using
  `rum.webVitals.metrics.attributes`. — **Evidence/rationale**: issue #191
  explicitly excludes metric labels, and current docs expose an explicit
  low-cardinality metric callback.
- **Rejected**: put `getRouteName` in `urlAttributes` or replace
  `logfire.page.url.path`. — **Reason**: issue #190 requires an additional
  dimension and preservation of raw/path context.
- **Rejected**: evaluate route name only on SPA navigation events. —
  **Reason**: fetch/XHR, interactions, errors, Web Vitals, and manual spans also
  need the current route; universal span start is the established boundary.
- **Rejected**: re-evaluate session attributes on every span or replay chunk. —
  **Reason**: violates the requested immutable session snapshot and can create
  trace/replay disagreement.
- **Rejected**: add session attributes to resources, baggage, or metric
  defaults. — **Reason**: resources outlive browser-session rotation, baggage
  changes propagation semantics, and metric labels are explicitly out of
  scope.
- **Rejected**: accept dotted/hyphenated keys, arrays, JSON values, or already
  prefixed keys. — **Reason**: expands the indexing and namespace surface
  beyond the bounded contract.

### Spike Evidence

- None needed. Existing session rotation, persistence, universal span
  processing, replay transport construction, gzip decoding, and built-browser
  receipt fixtures directly establish the implementation and verification
  paths.

### Validation Baseline

| Command                                             | Status                 | Observed or expected result                |
| --------------------------------------------------- | ---------------------- | ------------------------------------------ |
| `vp run @pydantic/logfire-browser#test`             | Verified               | 13 files, 151 tests passed at `172dffa`    |
| `vp run @pydantic/logfire-session-replay#test`      | Verified               | 9 files, 145 tests passed at `172dffa`     |
| `vp run @pydantic/logfire-browser#typecheck`        | Verified               | TypeScript 6.0.3 passed at `172dffa`       |
| `vp run @pydantic/logfire-session-replay#typecheck` | Verified               | TypeScript 6.0.3 passed at `172dffa`       |
| `vp run @pydantic/logfire-browser#build`            | Discovered but not run | Required before built-fixture verification |
| `vp run @pydantic/logfire-session-replay#build`     | Discovered but not run | Required before built-fixture verification |
| `pnpm run check`                                    | Discovered but not run | Final full-workspace gate                  |

### Research Coverage

- **Depth**: Deep
- **Inspected**: GitHub issues/comments and open-PR references; browser public
  config/types; session state/persistence/rotation; universal span processor;
  Web Vitals span and metric paths; browser-to-replay bridge; replay config,
  session observation, active runtime, transport, metadata extraction, and
  envelope tests; built-browser privacy fixture pattern; package docs/example;
  manifests, exact tool versions, recent browser history, Changesets pattern,
  current commit and worktree.
- **Not inspected**: Logfire Platform replay ingest/index/query implementation
  because this PRP owns only the SDK producer contract; unrelated Node,
  Cloudflare Worker, API formatting, and hosted variable packages; remote
  OpenTelemetry/rrweb docs because no external API behavior changes.
- **Research confidence**: HIGH for SDK implementation, bounds, and direct
  evidence surfaces. Platform acceptance/indexing of the new optional metadata
  remains a downstream integration concern and is explicitly out of scope.

## Execution Contract

- **Planned at commit**: `172dffa`
- **Planning baseline**: clean worktree before creation of this PRP; preserve
  this planning artifact and any later user changes.

### Expected Changes

- `packages/logfire-browser/src/browserSession.ts` — public callback/value types,
  bounded snapshot normalization, persisted snapshot lifecycle, and route
  getter.
- `packages/logfire-browser/src/browserSession.test.ts` — validation,
  persistence, legacy hydration, reset/rotation, and callback containment.
- `packages/logfire-browser/src/BrowserSessionSpanProcessor.ts` — independent
  route and session attribute propagation.
- `packages/logfire-browser/src/BrowserSessionSpanProcessor.test.ts` — exact
  dynamic route, immutable session, unset, invalid, and throwing behavior.
- `packages/logfire-browser/src/sessionReplay.ts` — pass the browser-owned
  session snapshot into the optional replay peer.
- `packages/logfire-browser/src/sessionReplay.test.ts` — exact peer config and
  hot-path snapshot forwarding.
- `packages/logfire-browser/src/browserConfigure.integration.test.ts` and/or
  `browserMetrics.test.ts` — public configure propagation and metric exclusion.
- `packages/logfire-browser/src/index.ts` — export new public types if they are
  not covered by existing `BrowserSessionOptions` export.
- `packages/logfire-session-replay/src/types.ts` — standalone callback,
  normalized type, resolved config, and optional chunk metadata field.
- `packages/logfire-session-replay/src/sessionAttributes.ts` and
  `sessionAttributes.test.ts` — replay-boundary normalizer and exhaustive
  bounded validation.
- `packages/logfire-session-replay/src/index.ts` and `index.test.ts` — resolve
  callback and snapshot once per replay-session runtime, including rotation and
  throwing-callback containment.
- `packages/logfire-session-replay/src/transport.ts`,
  `transport.test.ts`, `extract.ts`, and `extract.test.ts` — propagate the
  immutable map into every envelope without mutating it or changing version.
- `packages/logfire-browser/test-fixtures/rum-dimensions/` — built-package
  real-browser fixture, receipt server, and deterministic verifier.
- `packages/logfire-browser/README.md`,
  `packages/logfire-session-replay/README.md`, and
  `docs/packages/browser.md` — public behavior, limits, privacy/cardinality,
  examples, metrics exclusion, and replay metadata.
- `examples/browser-rum-replay/src/main.ts` and
  `examples/browser-rum-replay/README.md` — representative application route
  and safe session-dimension configuration.
- `.changeset/browser-rum-custom-dimensions.md` — minor notes for both
  published packages.

### Explicitly Out of Scope

- Inferring route templates from raw URLs or framework-specific router
  integrations.
- Soft-navigation Web Vitals or changing when Web Vitals are measured.
- Adding route/session dimensions to metric labels, resources, baggage, replay
  custom events, or network payloads.
- An API to update attributes during an active browser session.
- Accepting arrays, JSON objects, user profiles, PII, unbounded keys/values, or
  automatic PII classification/scrubbing.
- Platform replay ingest validation, database/index schema, filters, queries,
  dashboards, UI, or rollout flags.
- Changing replay envelope version, upload URL, compression, sampling,
  delivery, lifecycle, or privacy defaults.
- Changing session id generation, idle/max-duration semantics, or the meaning
  of replay activity attributes.

### Scope Expansion Rule

Additional files may be changed when necessary to satisfy this PRP without
changing its intent or architecture. Record each added file and rationale in
Execution Notes. Pause for user direction if expansion materially changes
product behavior, the public key/value contract, replay envelope compatibility,
privacy posture, Platform requirements, or the one-PR decomposition.

### Pause and Reassess If

- Replay ingest rejects unknown optional `meta.sessionAttributes`, requires a
  different field shape/name, or requires an envelope-version bump.
- Supporting the immutable snapshot would require changing the browser session
  id or discarding existing valid stored sessions rather than hydrating them.
- Any browser instrumentation bypasses the configured provider/span processor,
  so the requested route/session propagation needs per-instrumentation hooks.
- A session callback must run asynchronously or return promises; this PRP
  intentionally defines a synchronous snapshot.
- Validation demonstrates route/session dimensions enter metrics through an
  implicit path not identified in reconnaissance.
- The implementation requires a production dependency or shared package solely
  to avoid the small defensive replay-boundary validation helper.
- Work overlaps uncommitted user changes in any expected source or fixture
  path.

## Context

### Key Files

- `packages/logfire-browser/src/browserSession.ts` — canonical browser-session
  state, storage, expiry, and per-page callback owner.
- `packages/logfire-browser/src/BrowserSessionSpanProcessor.ts` — universal
  span-start augmentation boundary.
- `packages/logfire-browser/src/index.ts` — public configure resolution,
  processor registration, type exports, and optional feature startup.
- `packages/logfire-browser/src/browserMetrics.ts` — separate metric attribute
  construction that must remain independent.
- `packages/logfire-browser/src/sessionReplay.ts` — optional peer contract and
  browser-owned session-id bridge.
- `packages/logfire-session-replay/src/index.ts` — standalone public entry point
  and per-session active-runtime lifecycle.
- `packages/logfire-session-replay/src/transport.ts` — one transport per replay
  session and central envelope creation.
- `packages/logfire-session-replay/src/types.ts` — exported version-1 replay
  envelope and public config types.
- `packages/logfire-session-replay/src/extract.ts` — deterministic metadata
  assembly.
- `packages/logfire-browser/test-fixtures/privacy-defaults/` — closest direct
  built-package trace/replay receipt pattern.
- `examples/browser-rum-replay/src/main.ts` — representative public RUM,
  auto-instrumentation, Web Vitals, metrics, and replay consumer.

### External References

- [Issue #190](https://github.com/pydantic/logfire-js/issues/190) — normalized
  route requirements and acceptance criteria.
- [Issue #191](https://github.com/pydantic/logfire-js/issues/191) — bounded
  session attribute requirements and acceptance criteria.

### Gotchas

- `BrowserSessionSpanProcessor.onStart()` currently returns early when location
  or URL sanitization is unavailable. Route evaluation takes no URL argument
  and session attributes already exist after `touch()`, so neither may be
  accidentally placed behind that early return.
- Route and URL callbacks have different lifecycles and failure boundaries.
  A thrown route callback must not suppress URL attributes; a thrown URL
  callback must not suppress route/session attributes.
- Browser session storage is tab-scoped and survives reloads. Keeping the
  snapshot only in manager memory would violate CX-2.
- The optional stored field is also an evaluation sentinel: `{}` means a
  configured callback already produced no valid values; absence means a legacy
  or callback-free session that may be hydrated once if configuration later
  supplies the callback.
- Session storage is application-controlled and can contain stale/tampered
  JSON. Persisted custom attributes must be revalidated without letting hostile
  values invalidate an otherwise usable session id/timestamp record.
- The callback's raw object must never be retained or mutated. Copy only
  normalized scalar entries into a new plain record and copy/freeze at
  boundaries as needed to prevent later consumer mutation from changing a
  snapshot. A callback or key-enumeration failure produces an empty snapshot;
  a throwing individual property getter omits only that entry and processing
  continues.
- Do not treat every JavaScript object as a record. Check the prototype before
  enumerating; reject arrays, functions, dates, and class instances. Proxy trap
  failures follow the exact browser-silent/replay-`onError` matrix above.
- ECMAScript own-property order places integer-like keys before other strings;
  the safe pattern begins with a lowercase letter, so accepted keys retain
  ordinary insertion order.
- Count only accepted entries toward the 20-entry output cap. Stop once 20
  valid entries are copied. Invalid and `undefined` entries do not consume the
  cap.
- Route names are application-owned and intentionally not derived from
  `location`; SPA state can change without a browser URL change and vice versa.
- The replay monitor reads session id without touching browser activity. Its
  new attribute getter must remain a peek and must not refresh session timeout.
- `ReplayTransport` is recreated per observed session id. Snapshot once at
  construction/activation; never call the consumer getter in `createEnvelope()`
  or per flush.
- Browser and replay packages cannot introduce a hard runtime dependency from
  browser to the optional peer. Mirrored config typing and lazy loading must
  remain intact.
- Optional `ChunkMeta.sessionAttributes` must be omitted when empty so old
  default envelopes remain byte-shape compatible apart from unrelated event
  data.
- Web Vitals are emitted both as spans and optional metrics. The span must gain
  the dimensions through the universal processor; the metric point must not.
- Browser instrumentation callback failures are host-safe by established
  convention. Do not throw configuration/runtime errors for invalid dynamic
  entries.

## Implementation Blueprint

### Data Models

```ts
export type BrowserSessionAttributeValue = string | number | boolean
export type BrowserSessionAttributesInput = Record<string, BrowserSessionAttributeValue | undefined>
export type BrowserSessionAttributes = Record<string, BrowserSessionAttributeValue>

export interface BrowserSessionOptions {
  getRouteName?: () => string | undefined
  getSessionAttributes?: () => BrowserSessionAttributesInput
  // existing options unchanged
}

export interface BrowserSessionState {
  id: string
  startedAt: number
  lastActivityAt: number
  sessionAttributes?: BrowserSessionAttributes
}

export interface ChunkMeta {
  // existing fields unchanged
  sessionAttributes?: SessionAttributes
}
```

Constants/invariants:

- `SESSION_ATTRIBUTE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u`
- `MAX_SESSION_ATTRIBUTES = 20`
- `MAX_SESSION_ATTRIBUTE_STRING_CODE_POINTS = 200`
- browser span name: `logfire.session.${key}`
- replay map field: `meta.sessionAttributes[key]`
- empty normalized maps are represented internally as an empty record and
  omitted from replay JSON.

### Tasks

```yaml
Task 1: Define and test browser session-dimension lifecycle
  MODIFY packages/logfire-browser/src/browserSession.ts:
    - Add exported input/value/snapshot types and both BrowserSessionOptions callbacks.
    - Add a bounded normalizer implementing the exact key, count, Unicode string, finite-number, boolean, undefined, own-property, and hostile-runtime contract.
    - Capture a new plain snapshot when createSession() creates an id.
    - Persist the snapshot with the session state and preserve it through touch().
    - Revalidate stored snapshots; lazily hydrate legacy valid records without changing their id, then persist the upgraded record.
    - Persist {} when a configured callback evaluates with no valid entries, while leaving the field absent for callback-free sessions, so reload does not re-run an evaluated-empty callback.
    - Add non-touching getters for current session attributes and dynamic route name; do not expose mutable internal state.
    - Contain callback/property-access failures and return an empty snapshot.
  MODIFY packages/logfire-browser/src/browserSession.test.ts:
    - Cover exact valid scalars, invalid key/type/undefined/non-finite/oversized omission, Unicode code-point boundary, property order, 20-valid-entry cap, inherited entries, Object.create(null), frozen records, rejected array/function/date/class containers, proxy traps, per-property throwing getter omission, whole-object/callback failure, and no mutation.
    - Cover one callback evaluation per new session, manager reload reuse, legacy hydration, idle/max/reset rotation, throwing storage, and tampered persisted attributes.
  MODIFY packages/logfire-browser/src/index.ts:
    - Export the new public types with existing BrowserSessionOptions exports.
  PATTERN: packages/logfire-browser/src/browserSession.ts:101-204 and browserSession.test.ts:60-203
  ENABLES: CX-2, CX-4
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-browser#test -- src/browserSession.test.ts
    - EXPECTED: Browser session validation and lifecycle tests pass with exact snapshot/callback counts.

Task 2: Propagate dynamic route and immutable session attributes to every span
  MODIFY packages/logfire-browser/src/BrowserSessionSpanProcessor.ts:
    - After touch(), set every normalized session entry under logfire.session.<key>.
    - Evaluate route name independently for each span and set logfire.page.route for string results.
    - Keep session, replay, route, and URL failure boundaries independent; do not gate route/session on location availability.
    - Preserve existing session id, replay state, and URL attributes exactly.
  MODIFY packages/logfire-browser/src/BrowserSessionSpanProcessor.test.ts:
    - Assert exact combined default session/url/route/custom attributes.
    - Change application route state between spans and assert per-span evaluation.
    - Cover absent, undefined, empty-string, hostile non-string, and throwing route results.
    - Prove throwing route and URL callbacks do not suppress each other's or session/replay attributes.
    - Prove session snapshot remains unchanged when callback source mutates until manager reset.
  MODIFY packages/logfire-browser/src/browserConfigure.integration.test.ts:
    - Configure through the public entry point with a real in-memory exporter and representative manual/log-like, Web Vital, fetch, and XHR spans.
    - Assert the universal provider path carries route/session attributes without instrumentation-specific hooks.
  PATTERN: packages/logfire-browser/src/BrowserSessionSpanProcessor.ts:49-83 and browserConfigure.integration.test.ts:99-186
  ENABLES: CX-1, CX-2, CX-4
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-browser#test -- src/BrowserSessionSpanProcessor.test.ts src/browserConfigure.integration.test.ts
    - EXPECTED: Dynamic route and immutable session attributes are exact on every representative browser span, with independent failure containment.

Task 3: Extend standalone replay with a bounded per-session metadata snapshot
  MODIFY packages/logfire-session-replay/src/types.ts:
    - Add exported scalar/input/normalized session attribute types.
    - Add optional getSessionAttributes to SessionReplayConfig and ResolvedSessionReplayConfig.
    - Add optional sessionAttributes to ChunkMeta without changing CHUNK_ENVELOPE_VERSION.
  CREATE packages/logfire-session-replay/src/sessionAttributes.ts:
    - Normalize into a new plain record with the same exact key/count/value contract as Task 1.
    - Return empty on callback/key-enumeration failure, omit only an individual throwing property, and report through the existing safe onError path only when appropriate; invalid user data remains silently omitted.
  CREATE packages/logfire-session-replay/src/sessionAttributes.test.ts:
    - Exhaustively cover the shared public contract, mutation isolation, every accepted/rejected container class, and exact onError call counts for callback/prototype/enumeration/property exceptions versus silent invalid omissions.
  MODIFY packages/logfire-session-replay/src/index.ts:
    - Resolve getSessionAttributes in config.
    - Evaluate it once per createActiveRuntime()/session id and pass the normalized snapshot into ReplayTransport.
    - On observed session rotation, create a fresh snapshot; never re-evaluate it per event/flush.
  MODIFY packages/logfire-session-replay/src/index.test.ts:
    - Assert one evaluation for multiple chunks in one session, fresh evaluation after id rotation, throwing callback containment, and exact metadata per upload session id.
  PATTERN: packages/logfire-session-replay/src/index.ts:79-129,183-210,358-398 and src/privacy.ts
  ENABLES: CX-3, CX-4
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-session-replay#test -- src/sessionAttributes.test.ts src/index.test.ts
    - EXPECTED: Standalone replay snapshots exactly once per session, rotates safely, and contains invalid/throwing input.

Task 4: Serialize replay session metadata through every chunk path
  MODIFY packages/logfire-session-replay/src/transport.ts:
    - Accept/store an immutable normalized sessionAttributes snapshot per transport.
    - Include it in every ordinary and lifecycle envelope through central metadata creation.
    - Omit the field for an empty snapshot and never retain/mutate caller-owned records.
  MODIFY packages/logfire-session-replay/src/extract.ts:
    - Extend computeChunkMeta with the optional normalized snapshot using an exact defensive copy.
  MODIFY packages/logfire-session-replay/src/transport.test.ts:
    - Decode gzip bodies and assert identical metadata across ordinary, split keepalive, retry, and multi-flush chunks.
    - Assert empty omission and source-object mutation isolation.
  MODIFY packages/logfire-session-replay/src/extract.test.ts:
    - Assert exact optional metadata shape alongside existing derived fields.
  PATTERN: packages/logfire-session-replay/src/transport.ts:108-159,177-225 and src/extract.ts:12-83
  ENABLES: CX-3, CX-4
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-session-replay#test -- src/transport.test.ts src/extract.test.ts
    - EXPECTED: Every decoded chunk path carries one exact immutable optional sessionAttributes map and envelope version remains 1.

Task 5: Bridge the browser-owned snapshot into optional replay
  MODIFY packages/logfire-browser/src/sessionReplay.ts:
    - Add getSessionAttributes to the mirrored peer config type and preserve the compile-time assignability check.
    - Pass a non-touching getter returning the current browser manager snapshot.
    - Do not add getSessionAttributes to top-level BrowserSessionReplayOptions; browser integrators configure it once under rum.session.
  MODIFY packages/logfire-browser/src/sessionReplay.test.ts:
    - Assert the peer receives a getter, startup initializes session state before it is read, repeated reads do not touch/re-evaluate, and reset/rotation yields the new snapshot.
    - Retain all existing optional peer and failure-containment assertions.
  PATTERN: packages/logfire-browser/src/sessionReplay.ts:26-48,139-147,149-196
  ENABLES: CX-3, CX-4
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-browser#test -- src/sessionReplay.test.ts
    - EXPECTED: Browser-to-peer config remains assignable and forwards only the sanitized current-session snapshot without activity writes.

Task 6: Prove Web Vitals span inclusion and metric exclusion
  MODIFY packages/logfire-browser/src/browserMetrics.test.ts and/or browserConfigure.integration.test.ts:
    - Configure route/session callbacks plus Web Vitals spans and metrics through public configure.
    - Assert the finished Web Vital span has logfire.page.route and exact logfire.session.* attributes.
    - Assert the histogram data-point attributes remain exactly web_vital.name, web_vital.rating, and any explicit metrics.attributes output; reject every implicit route/session key.
    - Preserve the existing ability to add a deliberate low-cardinality route through rum.webVitals.metrics.attributes.
  PATTERN: packages/logfire-browser/src/browserMetrics.ts:130-159,206-211 and browserMetrics.test.ts low-cardinality attribute test
  ENABLES: CX-1, CX-5
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-browser#test -- -t "Web Vitals|low-cardinality|session attributes|route"
    - EXPECTED: Web Vital spans gain both dimensions and Web Vital metrics gain neither unless explicitly supplied under a consumer-selected metric key.

Task 7: Add direct built-browser trace/replay acceptance
  CREATE packages/logfire-browser/test-fixtures/rum-dimensions/index.html:
    - Provide deterministic normal and hostile routes plus fetch, XHR, interaction, reload, idle-expiry rotation, and status controls without external credentials.
  CREATE packages/logfire-browser/test-fixtures/rum-dimensions/main.ts:
    - Import built browser dist and lazy-load built replay through the established neutral virtual module.
    - Configure dynamic getRouteName, generation-marked getSessionAttributes, Web Vitals, metrics, fetch/XHR/user-interaction auto-instrumentation, trace/replay loopback endpoints, and long automatic flush intervals.
    - Configure a short idle timeout and run deterministic before-reload, after-reload, and post-timeout rotation phases; flush/cleanup before reporting terminal completion.
    - On /hostile/, configure a throwing route callback and one record containing valid entries, invalid keys/values, an oversized string, a non-finite number, more than 20 valid entries, and an enumerable throwing getter; emit and flush a span plus real replay.
    - Persist only fixture phase and callback-count markers needed to resume after reload; do not bypass the SDK session store.
  CREATE packages/logfire-browser/test-fixtures/rum-dimensions/recorder.d.ts and vite.config.ts:
    - Reuse the privacy-defaults built replay/rrweb/fflate virtual-module and bounded receipt middleware patterns.
    - Bind a distinct strict loopback port, capture trace/metric/replay receipts, expose reset/read endpoints, and report progress by phase/session id.
  CREATE packages/logfire-browser/test-fixtures/rum-dimensions/verify.mjs:
    - Accept normal or hostile scenario selection; poll terminal state, decode OTLP trace/metric JSON and gzip replay envelopes, join trace/replay by session id, and assert every CX-1/CX-2/CX-3/CX-4 invariant exactly.
    - For hostile, require tracing/replay completion, exact agreement on the first 20 valid entries, omission of every named invalid entry, no route attribute, and preservation of session/replay/URL attributes.
    - Fail nonzero for missing/duplicate evidence, route/session mismatch, callback re-evaluation on reload, absent configured idle rotation, metadata drift, invalid-value leakage, metric leakage, or envelope version change.
    - Print only bounded non-sensitive counts, ids, route templates, and key names.
  PATTERN: packages/logfire-browser/test-fixtures/privacy-defaults/
  ENABLES: CX-1, CX-2, CX-3, CX-4, CX-5
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-session-replay#build && vp run @pydantic/logfire-browser#build
    - EXPECTED: Both public packages build and the fixture consumes dist output.
    - COMMAND: vp dev --config packages/logfire-browser/test-fixtures/rum-dimensions/vite.config.ts --host 127.0.0.1 --port 4180
    - EXPECTED: Loopback server stays active on port 4180; terminal success requires both normal and hostile fixture phases complete plus both verifier exits 0, terminal failure is either fixture phase failed, either verifier nonzero, or a 30-second per-scenario deadline; executor owns server process, port, browser sessions, and receipt cleanup.
    - FAILURE-LOCAL: Run node packages/logfire-browser/test-fixtures/rum-dimensions/verify.mjs <normal|hostile> --phase <before-reload|after-reload|rotated|hostile> against retained receipts to isolate the failed phase without rebuilding.
    - PROCESS-LIFECYCLE: Executor starts the Vite process, observes server-ready output, uses isolated normal and hostile agent-browser sessions, closes both, sends SIGTERM to the exact Vite process, and confirms port 4180 is free on success or failure.

Task 8: Document the bounded public contract and representative usage
  MODIFY packages/logfire-browser/README.md and docs/packages/browser.md:
    - Document both rum.session callbacks, exact route/session lifecycle, key/value/count bounds, prefixing, invalid omission, low-cardinality/non-PII requirements, reload persistence, and new-session refresh.
    - State that route/session attributes appear on spans/events including Web Vitals and auto-instrumentation spans but not implicitly on metrics.
    - Show deliberate metric route configuration separately.
  MODIFY packages/logfire-session-replay/README.md:
    - Document standalone getSessionAttributes, per-session snapshot behavior, exact bounds, invalid omission, and optional meta.sessionAttributes.
    - State that metadata is intended for safe dimensions, not profiles or arbitrary analytics.
  MODIFY examples/browser-rum-replay/src/main.ts and README.md:
    - Use getRouteName for routeTemplate(window.location.pathname) while leaving URL attributes at their privacy-safe defaults.
    - Add fixed safe sample session dimensions such as account_tier, app_region, and experiment_variant; do not derive them from editable user ids.
    - Update trace/replay expectations and keep metrics dimensions explicitly configured.
  CREATE .changeset/browser-rum-custom-dimensions.md:
    - Add minor entries for @pydantic/logfire-browser and @pydantic/logfire-session-replay describing normalized route and bounded session metadata support.
  PATTERN: packages/logfire-browser/README.md RUM Session Identity/Web Vitals/Session replay sections and examples/browser-rum-replay/src/main.ts
  ENABLES: CX-1, CX-2, CX-3, CX-4, CX-5
  VERIFY:
    - COMMAND: vp fmt --check packages/logfire-browser/README.md packages/logfire-session-replay/README.md docs/packages/browser.md examples/browser-rum-replay/src/main.ts examples/browser-rum-replay/README.md .changeset/browser-rum-custom-dimensions.md plans/033-browser-rum-custom-dimensions.md
    - EXPECTED: Public docs, example, changeset, and PRP are formatted and agree on names, limits, lifecycles, privacy guidance, replay shape, and metric exclusion.
    - COMMAND: node_modules/.bin/changeset status --output /tmp/prp033-changeset-status.json
    - EXPECTED: Changesets parses the repository and reports browser-rum-custom-dimensions with exactly minor releases for @pydantic/logfire-browser and @pydantic/logfire-session-replay.

Task 9: Run focused and integrated package gates
  ENABLES: CX-1, CX-2, CX-3, CX-4, CX-5
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-session-replay#test && vp run @pydantic/logfire-session-replay#typecheck && vp run @pydantic/logfire-session-replay#build && vp run @pydantic/logfire-browser#test && vp run @pydantic/logfire-browser#typecheck && vp run @pydantic/logfire-browser#build
    - EXPECTED: Both affected packages pass all tests, typechecks, and builds with no skipped feature tests.
    - FAILURE-LOCAL: Re-run the failing package phase with vp run <package>#<test|typecheck|build>; for tests, pass the exact test file or -t pattern named by Tasks 1-6.
    - COMMAND: pnpm run check
    - EXPECTED: The complete repository build, Vite+ checks, typechecks, tests, and release-tooling tests pass.
    - FAILURE-LOCAL: Run the failing root script from package.json directly; affected-package diagnosis remains the focused commands above.
```

### Integration Points

```yaml
PUBLIC_BROWSER_CONFIG:
  - packages/logfire-browser/src/browserSession.ts — both callbacks, public value types, and persisted snapshot contract.
  - packages/logfire-browser/src/index.ts — public type export and session processor registration.

SPAN_PROPAGATION:
  - packages/logfire-browser/src/BrowserSessionSpanProcessor.ts — universal log/span/auto-instrumentation/Web Vitals augmentation.

METRICS:
  - packages/logfire-browser/src/browserMetrics.ts — intentionally independent explicit metric dimensions.

OPTIONAL_PEER_BRIDGE:
  - packages/logfire-browser/src/sessionReplay.ts — non-touching sanitized snapshot getter passed during lazy peer configuration.

STANDALONE_REPLAY:
  - packages/logfire-session-replay/src/types.ts — public callback and optional metadata schema.
  - packages/logfire-session-replay/src/index.ts — one snapshot per active replay session.
  - packages/logfire-session-replay/src/transport.ts — immutable snapshot on every chunk.
  - packages/logfire-session-replay/src/extract.ts — central optional metadata assembly.

PERSISTENCE:
  - lf_browser_session sessionStorage record — optional sanitized sessionAttributes field; legacy records hydrate without id rotation.

DIRECT_ACCEPTANCE:
  - packages/logfire-browser/test-fixtures/rum-dimensions/ — built-package browser, OTLP/metric/replay receipts, reload/rotation, and exact verifier.

DOCUMENTATION:
  - package READMEs, docs/packages/browser.md, and browser-rum-replay example — one public privacy/cardinality contract.

RELEASE:
  - .changeset/browser-rum-custom-dimensions.md — minor releases for both public packages.
```

## Validation

Run the following focused, direct-consumer, formatting, and integrated gates
from the repository root:

```bash
# Focused browser package
vp run @pydantic/logfire-browser#test
vp run @pydantic/logfire-browser#typecheck
vp run @pydantic/logfire-browser#build

# Focused standalone replay package
vp run @pydantic/logfire-session-replay#test
vp run @pydantic/logfire-session-replay#typecheck
vp run @pydantic/logfire-session-replay#build

# Direct built-browser consumer acceptance
vp dev --config packages/logfire-browser/test-fixtures/rum-dimensions/vite.config.ts --host 127.0.0.1 --port 4180
agent-browser --session rum-dimensions open "http://127.0.0.1:4180/projects/123"
agent-browser --session rum-dimensions wait --fn "window.__logfireRumDimensions?.phase === 'complete'"
node packages/logfire-browser/test-fixtures/rum-dimensions/verify.mjs normal
agent-browser --session rum-dimensions close
agent-browser --session rum-dimensions-hostile open "http://127.0.0.1:4180/hostile/"
agent-browser --session rum-dimensions-hostile wait --fn "window.__logfireRumDimensions?.phase === 'complete'"
node packages/logfire-browser/test-fixtures/rum-dimensions/verify.mjs hostile
agent-browser --session rum-dimensions-hostile close
# Stop the exact Vite process and confirm port 4180 is free.

# Docs/release artifact
vp fmt --check packages/logfire-browser packages/logfire-session-replay docs/packages/browser.md examples/browser-rum-replay .changeset/browser-rum-custom-dimensions.md plans/033-browser-rum-custom-dimensions.md
node_modules/.bin/changeset status --output /tmp/prp033-changeset-status.json

# Integrated repository gate
pnpm run check
```

The `CX-N` table is authoritative. Package tests provide direct public-config
evidence for hostile input and metrics behavior; the built-browser fixture is
required for real auto-instrumentation, reload persistence, session rotation,
and trace-to-replay metadata correlation. Source-level tests alone do not
satisfy CX-1, CX-2, or CX-3.

## Unknowns & Risks

- **Replay ingest compatibility**: this repository can prove the emitted
  version-1 JSON shape but not Platform parser/index behavior. The optional
  field is planned as additive. If Platform uses a closed schema that rejects
  it or requires a different name, execution must pause rather than silently
  ship unusable metadata.
- **Duplicate validation logic**: browser spans require validation without a
  runtime dependency on the optional replay peer, while standalone replay must
  defend its own public boundary. Two small implementations may drift. Keep
  constants, types, examples, and table-driven tests textually aligned; do not
  add a new production package/dependency for this bounded helper.
- **Legacy hydration**: a pre-feature stored session receives its first snapshot
  on the first upgraded page load rather than at its historical start time.
  This is the only compatible way to preserve the id and make the feature
  available before rotation. Once hydrated, it is immutable.
- **Callback side effects**: consumers may make callbacks stateful. The SDK
  guarantees route evaluation per span and session evaluation once per
  session/legacy hydration, so docs and tests must make counts explicit.
- **Stored-session tampering**: same-origin application code can edit
  `sessionStorage`. Revalidation bounds output but is not an authenticity
  mechanism; applications remain responsible for supplying non-PII dimensions.
- **Value length interpretation**: the public cap is 200 Unicode code points,
  not UTF-16 code units or bytes. Implementation must not use plain
  `string.length` for the acceptance boundary.
- **Replay payload growth**: at maximum bounds, every replay chunk gains roughly
  several kilobytes before gzip. This is deliberate and bounded; it must not
  alter buffer event-byte accounting, which controls rrweb event retention
  rather than envelope metadata.
- **Route cardinality remains application-owned**: the SDK does not validate or
  infer templates. Documentation is the guardrail for low-cardinality,
  non-user-data route strings.
- **Issue ownership**: an external contributor expressed interest in #190.
  Confirm ownership before execution to avoid duplicated work.

**Confidence: 8/10** for one-pass implementation success. The propagation,
persistence, replay-rotation, envelope, and browser-fixture patterns all exist.
The main residual risk is downstream replay ingest's accepted optional metadata
schema; the PRP has an explicit pause gate rather than assuming Platform
compatibility.

## Verification Record

- **Verified**: 2026-07-28 from source baseline
  `172dffa41ef5effbdef4a8e750c059fb771fb986`, preserving the implementation,
  PRP, and all tracked/untracked workspace changes without staging or
  committing.
- **Independent Deep verification**: one fresh-context read-only verifier
  completed consumer acceptance, PRP compliance, and engineering-quality
  passes. Its initial pass found acceptance-harness, focused-test, and
  documentation gaps. After targeted fixes, the same verifier reproduced the
  affected evidence and reported `READY` with no remaining blocker.

| Scenario | Grade               | Direct evidence                                                                                                                                                                                                                                                                                                                                         | Limitations                                                                                                                                    |
| -------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `CX-1`   | `DIRECTLY VERIFIED` | The built browser fixture emitted document-load, manual duration, manual error, Web Vital, click, fetch, and XHR spans. The verifier required exact pre-change route, default URL, and session dimensions; required `/settings` after route state changed; and exercised a second public configuration with `getRouteName` omitted.                     | Uses the repository's loopback Vite/OTLP fixture and built package exports; no framework-specific router adapter is claimed.                   |
| `CX-2`   | `DIRECTLY VERIFIED` | The normal browser run retained one session id and exact generation-1 snapshot across a same-tab reload, exposed callback count `2` for exactly two browser sessions, then produced a new id and generation-2 snapshot after configured idle expiry.                                                                                                    | Session persistence is exercised through browser `sessionStorage`; abrupt browser-process loss is outside the documented tab-session contract. |
| `CX-3`   | `DIRECTLY VERIFIED` | The verifier decoded every scenario-matching gzip replay receipt. All three envelopes remained version 1; every first-session chunk contained the exact generation-1 snapshot, while every rotated-session chunk contained generation 2 and matched span attributes by session id.                                                                      | Platform ingest/index acceptance of the additive optional field remains explicitly out of scope.                                               |
| `CX-4`   | `DIRECTLY VERIFIED` | The sequential hostile browser run retained tracing, replay, URL, and session identity while omitting the throwing route and invalid session values. It retained the first 20 valid entries in order, including the 200-code-point boundary, and replay metadata exactly matched the span map. Focused tests covered callback/container/proxy failures. | Runtime validation bounds data but does not classify or scrub PII; applications must supply safe dimensions.                                   |
| `CX-5`   | `DIRECTLY VERIFIED` | Real Web Vital spans carried route and session dimensions. All 16 normal-run metric points contained exactly `web_vital.name` and `web_vital.rating`, with no implicit `logfire.page.route` or `logfire.session.*` keys.                                                                                                                                | Browser timing determines which standard Web Vitals produce samples; the contract is asserted across every emitted point.                      |

### Compliance and Engineering Evidence

- All six success criteria and nine blueprint tasks are implemented. Public
  types, persisted legacy hydration and empty-snapshot sentinel behavior,
  per-session replay rotation, every-envelope metadata, documentation,
  representative example usage, and the two-package minor changeset match the
  PRP. Explicit exclusions held.
- The direct built-browser fixture supplies the joint public-config Web Vital
  span/metric evidence from Task 6, alongside focused integration and metric
  tests. This is a stronger public-boundary exercise than the originally
  suggested fully mocked joint assertion and does not change scope.
- Independent engineering review found the production implementation correct
  for bounded browser/replay normalization parity, callback failure
  containment, storage compatibility, immutable snapshots, optional-peer
  loading, metric separation, and version-1 envelope compatibility.
- The documented normal then hostile sequence passed on one unchanged server:
  the final main-agent run observed 79 normal spans, three replay receipts,
  sixteen metric points, and two replay session ids, followed by 34 hostile
  spans, one replay receipt, and eight metric points. The independent follow-up
  separately reproduced the sequence with 78 normal spans and the same replay,
  metric, and hostile evidence.

| Gate                                        | Result                                                                                                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PRP structural validator                    | Passed with zero warnings                                                                                                                                  |
| Focused replay tests and typecheck          | 93 focused tests passed; complete replay suite passed 152 tests                                                                                            |
| Focused browser tests and typecheck         | Complete browser suite passed 168 tests                                                                                                                    |
| Affected package and fixture builds         | Both packages and the built `rum-dimensions` consumer fixture passed                                                                                       |
| Sequential direct browser acceptance        | Normal and hostile scenarios passed on one server; phase selectors, receipt isolation, fetch/XHR spans, omitted route, replay chunks, and metrics verified |
| Formatting, lint, typecheck, and Changesets | Passed; Changesets selects minor releases for exactly `@pydantic/logfire-browser` and `@pydantic/logfire-session-replay`                                   |
| `pnpm run check`                            | Passed all package builds, formatting, lint, typechecks, tests, and release-tooling tests                                                                  |
| `git diff --check` and process cleanup      | Passed; browser sessions closed, Vite stopped, and port 4180 confirmed free                                                                                |

**Final status: `VERIFIED`.**
