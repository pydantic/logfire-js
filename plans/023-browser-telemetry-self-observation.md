# Prevent Browser Telemetry from Observing Itself

## Goal

Ensure browser-integrated trace, metric, and replay uploads are neither captured as replay network events nor instrumented into new export-generating spans, whether their configured endpoints are relative or absolute and regardless of the lazy-start order inside `logfire.configure(...)`. Preserve the standalone replay package's narrower contract: it flattens an already-installed OpenTelemetry fetch wrapper to protect exporter bypass, while standalone consumers must configure both replay and telemetry instrumentation ignore lists in either wrapper order.

## Why

- A relative endpoint such as `/logfire-proxy/v1/traces` is converted to an absolute URL by the exporter before `fetch`, while the current replay ignore regex remains relative and anchored. The SDK can therefore record its own traffic and produce self-sustaining replay uploads.
- OpenTelemetry's OTLP fetch transport deliberately calls `fetch.__original` to avoid export -> span -> export loops. Replay's later wrapper hides that escape hatch, re-enabling the loop when auto-instrumentation is active.
- Browser replay startup and lazy auto-instrumentation startup are asynchronous. Browser integration knows every SDK endpoint and must remain correct in either internal start order; standalone replay cannot infer separately configured trace/metric endpoints.

## Success Criteria

- [ ] SDK-generated endpoint patterns match directly issued relative URLs and canonical absolute URLs resolved from both exporter and browser-document bases, without changing consumer-supplied regex behavior or suppressing application descendants of exact trace/metric endpoints.
- [ ] The replay fetch wrapper exposes OpenTelemetry-compatible `__original` metadata flattened to the underlying uninstrumented fetch and retains current ownership-aware cleanup behavior.
- [ ] Browser auto-instrumentation always merges trace, metric, and replay endpoints into fetch and XHR `ignoreUrls`, while preserving consumer configuration, disabled instrumentation state, and input-object immutability.
- [ ] Public browser configuration with relative endpoints, auto-instrumentation, and replay produces bounded exports: SDK requests create neither replay network events nor new HTTP client spans.
- [ ] Focused browser/replay tests, typechecks, builds, and the roadmap's direct consumer exercise pass.

## Roadmap Context

- **Parent roadmap**: `plans/roadmaps/001-browser-rum-release-remediation.md`
- **Roadmap step**: `R1` — Prevent SDK telemetry from observing itself.
- **Satisfied dependencies**: combined blockers B1/B2 are source-reproduced; no roadmap-level product decision or spike remains for this child.
- **Inherited decisions and invariants**: preserve custom ignore patterns, request semantics, wrapper ownership/cleanup, the replay wire envelope, and the proxy-first deployment model. Do not rely on OpenTelemetry global teardown.
- **Contract produced for later steps**: canonical internal telemetry endpoint patterns and recursion-free wrapper behavior consumed by the final R9 browser integration/release gate.

## Consumer Contract

### Consumer and Public Boundary

- **Consumer(s)**: browser SDK integrators enabling `autoInstrumentations`, browser metrics, and session replay; host applications whose fetch/XHR traffic is patched; the final R9 integration verifier.
- **Public or supported boundary**: `logfire.configure(...)` options `traceUrl`, `metrics.metricUrl`, `autoInstrumentations`, and `sessionReplay`; standalone replay's public `startSessionReplay(...)` with explicit replay/telemetry ignore configuration when OTel instrumentation is present; emitted HTTP spans and uploaded replay network events.
- **Entry point and prerequisites**: a browser page with fetch/XHR, configured relative or absolute telemetry proxy endpoints, replay capture enabled, and fetch/XHR auto-instrumentation enabled. Browser-integrated replay URLs must have a non-root path and no query or fragment so the SDK can distinguish replay session children from ordinary application routes and construct a valid upload URL.
- **Current observable behavior**: relative configured endpoints fail to match absolute exporter requests; replay can hide OpenTelemetry's one-layer `fetch.__original` escape hatch; replay uploads can race auto-instrumentation startup and become HTTP spans.
- **Observable promise**: SDK-owned trace, metric, and replay traffic is excluded from replay network capture and fetch/XHR instrumentation, while ordinary application traffic remains observable and consumer ignore rules remain effective.
- **Must remain compatible with**: `@opentelemetry/auto-instrumentations-web` 0.64.0 configuration, `@opentelemetry/instrumentation` 0.219.0 wrapper metadata, OTLP exporter base 0.219.0, consumer `ignoreUrls`/`ignoreUrlPatterns`, relative proxy URLs, exact trace/metric endpoint semantics, replay session-child paths, and later third-party wrappers.
- **Not claimed**: automatic standalone suppression in either wrapper order when the consumer omits replay/telemetry endpoints from replay `ignoreUrlPatterns` or OTel fetch/XHR `ignoreUrls`; suppression of application descendants of trace/metric paths; guaranteed recursion prevention for arbitrary third-party instrumentations that ignore OpenTelemetry conventions; or any change to captured payload privacy.

### Acceptance Scenarios

| ID     | Given                                                                                                                                                                               | When                                                                                                                                                  | Then                                                                                                                                                                                                                                                                                   | Evidence surface                                                                                                                  | Required evidence                                                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `CX-1` | A page at a nested URL configures relative trace, metric, and non-root replay proxy paths with browser auto-instrumentation, Web Vitals metrics, and replay network capture         | While replay remains active, the page creates one manual span, one FCP Web Vital metric export, one replay upload, and one ordinary application fetch | During a fixed observation window, trace/metric/replay receipts stay within fixture-defined finite bounds; decoded replay and OTLP spans contain no SDK endpoint, while the application request appears once at the proxy, once in replay, and once as an HTTP client span             | Repository Vite receipt fixture using built public packages, real browser, real OTel auto-instrumentation, and gzip/OTLP decoding | DIRECT REQUIRED                                                                                                     |
| `CX-2` | Fetch is already wrapped by installed OpenTelemetry, standalone replay/OTel ignore lists include all SDK endpoints, and the wrapper exposes its underlying function as `__original` | Standalone replay starts network capture, then OTLP-style code selects `globalThis.fetch.__original`                                                  | The selected function is the underlying uninstrumented fetch, the export request bypasses both wrappers, replay uploads are ignored by OTel, and stopping replay restores only the wrapper it owns                                                                                     | Public `startSessionReplay()` with installed OTel instrumentation in jsdom                                                        | PROXY ACCEPTABLE — jsdom exercises the installed wrapper/config contract but not a browser network stack            |
| `CX-3` | A consumer supplies fetch/XHR auto-instrumentation options with existing string/regex `ignoreUrls`, or explicitly disables one instrumentation                                      | Browser configuration adds SDK endpoint suppression                                                                                                   | Existing options and disable flags are unchanged, SDK patterns are appended without mutating the caller's object, and application URLs not covered by either list remain instrumented                                                                                                  | Public `configure()` test with installed auto-instrumentation constructors plus observed spans where enabled                      | PROXY ACCEPTABLE — isolated jsdom/config control cannot prove real lazy chunk timing, which CX-1 covers             |
| `CX-4` | Trace/metric endpoints use absolute or relative forms, preserved trailing slashes, queries, or fragments; replay uses a query-free non-root base                                    | Replay and auto-instrumentation evaluate exact endpoints, replay session children, application descendants, and sibling lookalikes                    | Exact trace/metric requests and replay session children are suppressed; trace/metric descendants such as `/api/users`, replay siblings, and unrelated application paths remain observable; root/query/fragment replay bases report a contained startup error and replay does not start | Public configuration/capture tests at controlled nested `globalThis.location.href` and differing `document.baseURI`               | PROXY ACCEPTABLE — deterministic URL matrix validates matching semantics; CX-1 proves a representative browser path |
| `CX-5` | Browser-integrated replay is ready before the lazy auto-instrumentation module, and then the inverse order is forced                                                                | Public `configure()` completes and SDK requests occur                                                                                                 | Both orders install the same endpoint ignores and produce no SDK-observation events/spans                                                                                                                                                                                              | Public `configure()` with controlled lazy-module promises and installed OTel constructors                                         | PROXY ACCEPTABLE — import timing is controlled in-process; CX-1 supplies the real-browser result                    |

## Research Summary

### Vetted Repository Findings

- `packages/logfire-browser/src/sessionReplay.ts:169-180,267-284` — browser integration creates one anchored regex from each configured string, without resolving relative endpoints against the page URL. — **PRP impact**: replace the local helper with shared raw-plus-canonical endpoint-kind patterns.
- `packages/logfire-session-replay/src/capture.ts:126-186,340-361` — replay wraps `window.fetch` but assigns no `__original` property; its generic patch cleanup already restores only when the owned wrapper is still current. — **PRP impact**: add fetch-specific metadata without weakening cleanup or applying OTel semantics to unrelated method wrappers.
- `packages/logfire-session-replay/src/index.ts:302-337` — the default replay transport binds whichever global fetch exists when replay starts. — **PRP impact**: browser integration must inject replay endpoints into auto-instrumentation ignores; wrapper installation order alone cannot guarantee suppression.
- `packages/logfire-session-replay/src/transport.ts:189-197` — replay uploads use the captured `fetchImpl` and append `/{sessionId}?seq=...` to the configured replay URL. — **PRP impact**: only replay uses child-path semantics; trace and metrics remain exact endpoints.
- `packages/logfire-browser/src/index.ts:452-460` and `packages/logfire-browser/src/browserMetrics.ts:8-28` — trace and metric exporters receive one configured URL rather than an endpoint base for child resources. — **PRP impact**: never use replay-style descendant matching for trace/metric URLs.
- `packages/logfire-browser/src/index.ts:290-352` — auto-instrumentation config is resolved and passed to `getWebAutoInstrumentations()` without SDK endpoint ignores. — **PRP impact**: clone and augment fetch/XHR configs before the lazy import/registration boundary.
- `packages/logfire-browser/src/sessionReplay.test.ts:70-147` — current tests prove only that relative generated regexes match relative strings. — **PRP impact**: add absolute-request and sibling-path assertions at a controlled page base.
- `packages/logfire-session-replay/src/capture.test.ts:379-419` — existing tests cover ignored fetch/XHR URLs and stateful regex normalization but not wrapper metadata. — **PRP impact**: extend the existing ownership/capture suite with a flattened `__original` interaction.
- `packages/logfire-browser/src/index.test.ts:279-283,789-830` — the suite already mocks `getWebAutoInstrumentations()` and asserts enable/disable configuration. — **PRP impact**: use this boundary to prove exact merged inputs and immutability before adding a smaller real-instrumentation integration exercise.

### External Constraints

- `@opentelemetry/otlp-exporter-base` 0.219.0, installed `build/esm/transport/fetch-transport.js:41-50` — the exporter reads one `globalThis.fetch.__original` function specifically to break an endless export/span loop.
- `@opentelemetry/instrumentation` 0.219.0, installed `build/esm/shimmer.js:7-39` — OTel defines wrapper metadata as configurable/writable and normally points `__original` at the immediate predecessor. Because the exporter unwraps once, replay must flatten an already wrapped predecessor to `predecessor.__original ?? predecessor`.
- `@opentelemetry/auto-instrumentations-web` 0.64.0, installed `build/esm/utils.d.ts` — fetch and XHR accept separate configuration objects, each with `ignoreUrls`; disabled state is carried by the shared instrumentation config.
- `@opentelemetry/instrumentation-fetch` and `@opentelemetry/instrumentation-xml-http-request` 0.219.0 — regex `ignoreUrls` partially match the parsed absolute URL, while string entries require an exact match. Generated regexes must therefore be anchored with endpoint-kind-specific boundaries.
- `@opentelemetry/otlp-exporter-base` 0.219.0, installed `build/esm/configuration/otlp-http-configuration.js:25-37` — relative exporter URLs resolve against `globalThis.location.href`; installed fetch/XHR instrumentation resolves raw relative requests through browser URL parsing, which follows `document.baseURI`. — **PRP impact**: canonical patterns need both bases when they differ, plus the original raw form.

### Settled Decisions and Rejected Alternatives

- **Decision**: create one browser-internal URL-pattern helper with explicit endpoint kinds. Preserve the configured trailing slash for exact trace/metric endpoints; match that path exactly, including an explicitly configured query (with optional fragment) or allowing query/fragment on the same path when none was configured. Replay alone trims trailing path slashes before matching `/{sessionId}` children. Emit deduplicated raw, `new URL(value, globalThis.location.href)` exporter-canonical, and `new URL(value, document.baseURI)` instrumentation-canonical forms when those bases differ. — **Evidence/rationale**: exporters and instrumentation resolve relative URLs against different browser bases; generic prefix or slash normalization would miss real requests or suppress `/api/users`.
- **Decision**: reject browser-integrated replay URLs whose resolved pathname is `/` or which contain a query/fragment; reject query/fragment in standalone replay validation as well. — **Evidence/rationale**: root makes every same-origin route a possible session child, and current `ReplayTransport` appends `/{sessionId}?seq=` after the entire configured string, making query/fragment bases invalid. Standalone root remains supported only with explicit owner-provided ignores.
- **Decision**: merge generated endpoint patterns into both fetch and XHR auto-instrumentation configs without mutating the caller's `autoInstrumentations` object. — **Evidence/rationale**: replay upload startup can bind an already instrumented fetch; proactive ignores make wrapper timing irrelevant and cover future XHR-based SDK transport changes.
- **Decision**: attach flattened `__original` metadata only to the replay fetch wrapper, using the descriptor shape expected by OTel. — **Evidence/rationale**: the exporter unwraps one layer; adding the convention to console/history/XHR method wrappers is unnecessary and could misrepresent ownership.
- **Rejected**: blindly unwrap the fetch used by standalone replay transport. — **Reason**: that would bypass caller-supplied monitoring/security wrappers and change standalone behavior; suppression belongs in browser integration configuration.
- **Rejected**: rely only on injected auto-instrumentation `ignoreUrls`. — **Reason**: replay network capture still needs its own endpoint suppression, and third-party/exporter paths rely on `__original` independently.
- **Rejected**: normalize every observed application URL before applying consumer `ignoreUrlPatterns`. — **Reason**: consumers may intentionally match the original relative request string; generated SDK patterns can cover both forms without changing that contract.
- **Rejected**: claim either wrapper order is automatically self-observation-safe for standalone replay. — **Reason**: flattened metadata protects the OTLP exporter escape hatch, but standalone replay does not know independently configured endpoints and its captured transport fetch can still be instrumented; document both required ignore lists instead of expanding its configuration contract.

### Spike Evidence

- None needed for this child. B1 follows deterministically from the anchored relative regex and exporter absolute request; B2 is explicitly documented by the installed exporter source and the missing wrapper property. Roadmap spikes are reserved for the separate lifecycle/unload/CSP uncertainties.

### Validation Baseline

| Command                                             | Status                 | Observed or expected result                                                                            |
| --------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `vp run @pydantic/logfire-session-replay#test`      | Verified               | 8 files, 95 tests pass at `f57d9ec`; missing B2 regression                                             |
| `vp run @pydantic/logfire-browser#test`             | Verified               | 6 files, 90 tests pass at `f57d9ec`; current relative-only assertions pass while B1 remains            |
| `vp run @pydantic/logfire-session-replay#typecheck` | Discovered but not run | Required after implementation                                                                          |
| `vp run @pydantic/logfire-browser#typecheck`        | Discovered but not run | Required after implementation                                                                          |
| Vite receipt fixture with real browser              | Missing                | This child creates the repository-native direct consumer surface before implementation can be verified |

### Research Coverage

- **Depth**: Deep.
- **Inspected**: browser configuration and lazy auto-instrumentation startup; replay integration configuration; standalone fetch/XHR capture and transport binding; relevant browser/replay tests; installed OTel exporter, shimmer, fetch/XHR instrumentation, and auto-instrumentation types.
- **Not inspected**: provider reconfiguration, replay privacy payloads, unload/compression, proxy server implementation, and backend ingest because separate roadmap children own those contracts.
- **Research confidence**: HIGH — both defects and the required compatibility conventions are directly visible in current and installed primary source; no architectural unknown remains for this bounded child.

## Execution Contract

- **Planned at commit**: `f57d9ec`
- **Planning baseline**: preserve the pre-existing untracked `plans/020-browser-rum-replay-lifecycle.md`, `reports/pr-161-review.md`, and `reports/pr-161-combined-review.md`; also preserve the parent roadmap and its three research records created during this planning phase. Do not stage or rewrite unrelated planning/report artifacts during implementation.

### Expected Changes

- `packages/logfire-browser/src/telemetryUrls.ts` — new internal helper for endpoint-kind-specific raw and browser-canonical patterns plus auto-instrumentation merging support if that keeps ownership cohesive.
- `packages/logfire-browser/src/telemetryUrls.test.ts` — exact URL normalization, endpoint-kind boundaries, deduplication, and immutable config merge tests if helper-level tests improve clarity.
- `packages/logfire-browser/src/sessionReplay.ts` and `sessionReplay.test.ts` — consume shared telemetry patterns and prove relative/absolute replay suppression.
- `packages/logfire-browser/src/index.ts` and `index.test.ts` — merge SDK endpoint patterns into fetch/XHR auto-instrumentation config while preserving consumer configuration/disabled state.
- `packages/logfire-session-replay/src/capture.ts` and `capture.test.ts` — publish flattened OTel-compatible `__original` metadata on the replay fetch wrapper and test bypass/cleanup.
- `packages/logfire-session-replay/src/index.ts` and `index.test.ts` — reject replay base URLs whose query/fragment would be corrupted by session URL construction and cover the public standalone OTel interaction with explicit bidirectional ignores.
- `packages/logfire-session-replay/README.md` — document the standalone wrapper-order prerequisite and explicit telemetry endpoint ignores.
- `packages/logfire-browser/test-fixtures/self-observation/` — required Vite page/receipt plugin for `CX-1`, using built public packages and real auto-instrumentation without production dependencies.

### Explicitly Out of Scope

- OpenTelemetry provider cleanup/reconfiguration or any `trace/context/propagation.disable()` call; roadmap R2 owns lifecycle.
- Replay navigation/DOM/console privacy, URL redaction, or page attribute defaults; roadmap R5 owns privacy.
- Keepalive scheduling, compression fallback, retries, proxy changes, release metadata, and package publication.
- Changing the public `autoInstrumentations`, `sessionReplay`, or standalone replay option shapes.
- Broadly suppressing user traffic that merely shares an origin with a telemetry endpoint.

### Scope Expansion Rule

Additional files may change when necessary to add a focused outside-in browser fixture or keep a shared internal URL helper cohesive. Record each addition in Execution Notes. Pause for user direction if suppression requires a new public option, changes consumer-provided regex semantics, bypasses arbitrary caller fetch wrappers, or alters endpoint/request behavior rather than observation only.

### Pause and Reassess If

- The installed OTel auto-instrumentation cannot merge SDK `ignoreUrls` while preserving an explicitly disabled fetch/XHR configuration.
- The Vite receipt fixture cannot produce and observe a real Web Vitals metric export while replay remains active.
- A real-browser exercise shows exporter recursion even when the replay wrapper exposes the flattened `__original` and endpoint ignores are installed.
- Correct canonical matching requires broad origin-level suppression or exposes credentials through diagnostics/test snapshots.
- Direct consumer verification requires adding a new production dependency or modifying proxy behavior owned by R7.
- Implementation overlaps pre-existing user changes or another roadmap child's source scope.

## Context

### Key Files

- `packages/logfire-browser/src/sessionReplay.ts` — currently owns generated replay ignore patterns; integration point for the shared endpoint matcher.
- `packages/logfire-browser/src/index.ts` — owns auto-instrumentation config resolution and knows all configured trace/metric/replay endpoints.
- `packages/logfire-browser/src/index.test.ts` — existing lazy auto-instrumentation mock/capture pattern.
- `packages/logfire-session-replay/src/capture.ts` — fetch/XHR wrappers and ownership-aware method patching.
- `packages/logfire-session-replay/src/index.ts` — binds default replay transport fetch before capture starts.
- `packages/logfire-session-replay/src/transport.ts` — constructs session child URLs and calls captured fetch.
- Installed OTel `otlp-exporter-base/build/esm/transport/fetch-transport.js` — authoritative one-layer `__original` consumer.
- Installed OTel `instrumentation/build/esm/shimmer.js` — wrapper metadata descriptor pattern.

### External References

- [OpenTelemetry JS repository](https://github.com/open-telemetry/opentelemetry-js) — upstream source corresponding to installed exporter/instrumentation packages; execution should continue to pin behavior to installed versions.

### Gotchas

- OTLP transport constructs an absolute URL before fetch, while application code and replay transport may call fetch with the original relative string; generated patterns must cover both.
- Resolve exporter-canonical forms against `globalThis.location.href`, exactly matching the installed exporter, and instrumentation-canonical forms against `document.baseURI`, which a `<base>` element can intentionally change. Preserve the raw configured form as well.
- OTel's exporter unwraps exactly one property. Setting replay wrapper `__original` to the immediate OTel wrapper does not fix B2; flatten to its callable `__original` when present.
- Replay captures the current fetch with `.bind(globalThis)` before installing its own capture wrapper. Metadata on the later replay wrapper cannot by itself stop replay uploads from becoming OTel spans.
- `autoInstrumentations: true` and an omitted option map still need generated fetch/XHR configs. An explicit `enabled: false` on either instrumentation must remain false.
- Clone nested config and `ignoreUrls` arrays. Tests must prove the caller's original object/arrays are reference- and value-unchanged.
- Exact trace/metric matching preserves the configured trailing slash. Preserve an explicitly configured query exactly and allow an optional fragment; when configuration omitted a query, allow query/fragment only on that same exact path. Reject descendants and lookalikes. Replay alone trims a trailing path slash and accepts session children. Browser replay bases may not be root paths and browser or standalone replay bases may not contain a query or fragment.
- Do not log generated regex source when endpoint URLs could contain sensitive query data.

## Implementation Blueprint

### Data Models

No public model or wire-schema change. Introduce only internal helpers/types:

- A function that accepts `{ kind: 'exact' | 'replay-base', url }` entries plus the exporter base (`globalThis.location.href`) and instrumentation base (`document.baseURI`), returning deduplicated anchored `RegExp[]` for the raw form and both canonical forms, with exact trace/metric boundaries and replay-child boundaries.
- An internal auto-instrumentation config merger that clones fetch/XHR nested configs and arrays before appending SDK endpoint patterns.
- A fetch-wrapper metadata type containing optional callable `__original` for safe flattening without `any` leakage.

### Tasks

```yaml
Task 1: Add failing endpoint and wrapper interaction characterization
  MODIFY packages/logfire-browser/src/sessionReplay.test.ts:
    - Set a controlled nested globalThis.location.href and a differing document.baseURI, then prove relative trace, metric, and replay configuration matches exporter-canonical, instrumentation-canonical, and direct relative calls.
    - Assert exact trace/metric endpoint plus query/fragment matches but application descendants and sibling lookalikes do not.
    - Assert replay endpoint plus encoded session child/query matches but replay sibling lookalikes do not; root-only and query/fragment browser replay URLs report through contained startup failure and start no replay runtime.
    - Retain an exact assertion that caller-provided ignore regexes remain present and unmodified.
  MODIFY packages/logfire-browser/src/index.test.ts:
    - Capture the config passed to getWebAutoInstrumentations for autoInstrumentations=true and explicit nested fetch/XHR configs.
    - Prove SDK trace/metric/replay patterns are present, consumer string/regex ignores and enabled=false survive, and caller objects/arrays are not mutated.
    - Control the replay-load and auto-instrumentation promises to exercise both browser-integrated wrapper/start orders, using installed OTel constructors for wrapper behavior rather than a pattern-faithful fake.
  MODIFY packages/logfire-session-replay/src/capture.test.ts:
    - Install an OTel-shaped fetch wrapper over a base fetch, start replay capture, and prove replay's wrapper.__original is exactly the base fetch.
    - Invoke the selected __original and prove neither wrapper emits while ordinary window.fetch still captures once.
    - Stop replay and retain existing later-third-party-wrapper/ownership assertions.
  MODIFY packages/logfire-session-replay/src/index.test.ts:
    - Repeat the installed-OTel-predecessor case through public startSessionReplay() with real capture enabled and explicit bidirectional ignores: telemetry endpoints in replay ignoreUrlPatterns and the replay upload URL in OTel fetch/XHR ignoreUrls.
    - Prove standalone replay URLs containing a query or fragment are rejected before transport startup because ReplayTransport appends its session path and sequence query.
  SUPPORTS: CX-2, CX-3, CX-4, CX-5; these tests characterize the contract but do not pass until Tasks 2-4 implement it.
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-browser#test -- -t "ignore|auto-instrumentation"
    - EXPECTED: New absolute endpoint and merged-config assertions fail before implementation.
    - COMMAND: vp run @pydantic/logfire-session-replay#test -- -t "original|ignored fetch"
    - EXPECTED: New __original assertion fails before implementation; existing ignore tests remain green.

Task 2: Implement canonical SDK endpoint patterns
  CREATE packages/logfire-browser/src/telemetryUrls.ts:
    - Accept endpoint kind exact for trace/metric and replay-base for replay. Preserve exact-endpoint trailing slashes; trim replay-base trailing slashes without erasing a root pathname.
    - For exact endpoints, match only the endpoint: preserve an explicitly configured query exactly with optional fragment, or allow query/fragment on the same path when none was configured; never match descendant application paths.
    - For replay-base, additionally match slash-delimited encoded session children used by ReplayTransport.
    - Preserve a raw-form pattern and add deduplicated canonical absolute-form patterns when resolution against globalThis.location.href and document.baseURI succeeds.
    - Deduplicate equal normalized forms and escape regex metacharacters.
    - Keep invalid/non-resolvable raw strings matchable rather than throwing during optional replay startup.
  CREATE/MODIFY packages/logfire-browser/src/telemetryUrls.test.ts as appropriate:
    - Cover root-relative, path-relative at a nested location with a differing document.baseURI, absolute, preserved exact trailing slash, replay trailing slash normalization, metacharacters, invalid input, empty input, deduplication, exact/child boundaries, query, fragment, root exact endpoints, and root/query/fragment replay rejection.
    - Include negative exact-endpoint descendants such as trace /api versus application /api/users.
  MODIFY packages/logfire-browser/src/sessionReplay.ts:
    - Replace createUrlPrefixPattern/escapeRegExp with exact trace/metric and replay-base patterns from the shared helper.
    - Validate that the resolved browser replay pathname is not root and has no query or fragment before optional replay starts; report through the existing contained startup failure path.
    - Append consumer ignoreUrlPatterns unchanged after generated SDK patterns.
  ENABLES: CX-1, CX-4
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-browser#test -- -t "telemetry|replay|ignore"
    - EXPECTED: Relative and absolute endpoint forms are suppressed and lookalike paths remain observable.

  MODIFY packages/logfire-session-replay/src/index.ts:
    - Reject standalone replay URLs containing a query or fragment before transport startup; retain standalone root support because only the browser integration owns the non-root routing invariant.
  MODIFY packages/logfire-session-replay/src/index.test.ts:
    - Assert query/fragment replay URLs fail deterministically without starting capture or transport and ordinary query-free/root standalone URLs retain current behavior.

Task 3: Make auto-instrumentation suppression independent of startup order
  MODIFY packages/logfire-browser/src/index.ts:
    - Derive exact trace/metric patterns and replay-base patterns from traceUrl, optional metrics.metricUrl, and optional sessionReplay.replayUrl before lazy auto-instrumentation registration.
    - Extend resolveAutoInstrumentationsConfig or a focused helper to clone the config and merge generated patterns into @opentelemetry/instrumentation-fetch and @opentelemetry/instrumentation-xml-http-request ignoreUrls.
    - Handle autoInstrumentations=true by creating the two nested configs; preserve top-level and per-instrumentation enabled=false semantics and all unrelated options.
    - Do not add replay patterns when replay is disabled and do not mutate the caller's objects or arrays.
  MODIFY packages/logfire-browser/src/index.test.ts:
    - Assert exact merged fetch/XHR configs for relative and absolute endpoints, boolean true, explicit options, disabled instrumentation, and replay/metrics absent cases.
    - Assert normal application descendants of trace/metric paths and replay siblings are not covered by generated patterns.
    - Complete both controlled lazy-start orders and observe that installed enabled instrumentation creates an application span but no SDK endpoint span.
  PATTERN: packages/logfire-browser/src/index.ts:290-352
  ENABLES: CX-1, CX-3
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-browser#test -- -t "auto-instrumentation|ignore"
    - EXPECTED: Exact merged configs and input immutability pass.

Task 4: Preserve OpenTelemetry's unwrapped fetch escape hatch
  MODIFY packages/logfire-session-replay/src/capture.ts:
    - Build the fetch wrapper as a named local function/object so fetch-specific metadata can be defined before patchMethod installs it.
    - Define configurable, writable, non-enumerable __original pointing to originalFetch.__original when callable, otherwise originalFetch.
    - Leave generic patchMethod, other wrappers, request receiver/arguments/results/errors, active gating, and ownership-aware cleanup unchanged.
  MODIFY packages/logfire-session-replay/src/capture.test.ts:
    - Cover flattened and unwrapped predecessors, descriptor shape, bypass behavior, idempotent stop, and later wrapper ownership.
  MODIFY packages/logfire-session-replay/README.md:
    - State that replay flattens an OpenTelemetry wrapper already present at startup.
    - Document the two standalone owner obligations in either wrapper order: put trace/metric/replay endpoints in replay ignoreUrlPatterns so replay does not record SDK traffic, and put the replay upload URL in OTel fetch/XHR ignoreUrls so replay uploads are not instrumented.
    - Clarify that flattened __original metadata protects the OTLP exporter bypass only; it cannot infer or suppress independently configured replay uploads. Only browser integration can inject every known endpoint automatically.
  PATTERN: installed @opentelemetry/instrumentation build/esm/shimmer.js:7-39
  ENABLES: CX-2
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-session-replay#test -- -t "original|fetch"
    - EXPECTED: Metadata/bypass tests and all existing fetch capture behavior pass.

Task 5: Create and run the public real-browser receipt fixture
  CREATE packages/logfire-browser/test-fixtures/self-observation/vite.config.ts:
    - Serve a nested test page and same-origin relative /client-traces, /client-metrics, /client-replay/:sessionId, and /api/application routes from one loopback Vite server.
    - Record bounded request metadata/bodies in memory and expose a test-only receipt endpoint; decode trace/metric OTLP JSON and gzip replay envelopes without forwarding or credentials.
    - Keep this fixture outside package publication and production dependencies.
  CREATE packages/logfire-browser/test-fixtures/self-observation/index.html and main.ts:
    - Import the built public browser/replay packages through fixture aliases and enable real web auto-instrumentations.
    - Configure relative endpoints from a nested page URL, batchSpanProcessorConfig.scheduledDelayMillis=250, sessionReplay.flushIntervalMs=500, and metrics.metricReaderConfig.exportIntervalMillis=1000.
    - Render visible content before configuration and wait until the public Web Vitals integration has exported `logfire.browser.web_vital.fcp`; emit one ended `self-observation-manual` span and one ordinary /api/application fetch while replay remains active.
    - Expose window.__logfireSelfObservation.phase and a narrow cleanup() test control. Set phase='observing' only after the application request and manual span complete and FCP has been observed by the fixture; do not call cleanup until active-window receipt assertions finish.
  CREATE packages/logfire-browser/test-fixtures/self-observation/verify.mjs:
    - Poll receipts until trace, metric, replay, and application receipts exist, then observe an additional fixed four-second active window.
    - Enforce explicit fixture bounds during that window: 1..6 trace requests, 1..6 metric requests, and 1..3 replay requests. Fail on a count outside the bounds or monotonic trace/replay amplification rather than waiting for cleanup to stop it.
    - Decode every trace/metric/replay receipt; require the `self-observation-manual` span and `logfire.browser.web_vital.fcp` metric, and assert zero SDK endpoint HTTP spans/network events.
    - Assert /api/application appears exactly once at the proxy, exactly once as a replay Network event, and exactly once as an exported HTTP client span.
    - Assert only the active replay window and exit nonzero on any mismatch; cleanup is invoked by agent-browser afterward so it cannot create a false pass.
  ENABLES: CX-1
  VERIFY:
    - COMMAND: pnpm run build
    - EXPECTED: Public package outputs build before the scratch/browser consumer runs.
    - COMMAND: vp dev --config packages/logfire-browser/test-fixtures/self-observation/vite.config.ts --host 127.0.0.1 --port 4175
    - EXPECTED: Fixture and receipt routes listen only on loopback; keep this process active in a managed terminal.
    - COMMAND: agent-browser open http://127.0.0.1:4175/nested/page/
    - EXPECTED: The fixture opens in a real browser at a nested location.
    - COMMAND: agent-browser wait --fn "window.__logfireSelfObservation?.phase === 'observing'"
    - EXPECTED: The public SDK fixture has produced its manual span, application request, and deterministic FCP signal while replay remains active; periodic telemetry does not make readiness depend on network-idle heuristics.
    - COMMAND: node packages/logfire-browser/test-fixtures/self-observation/verify.mjs
    - EXPECTED: All three SDK receipt surfaces are exercised while replay is active, counts remain within explicit bounds, SDK requests are absent from decoded observations, and the application request has the three exact observations.
    - COMMAND: agent-browser eval "await window.__logfireSelfObservation.cleanup()"
    - EXPECTED: Cleanup succeeds only after active-window assertions have passed.

Task 6: Run focused and integrated gates
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-session-replay#test
    - EXPECTED: All replay tests pass with new wrapper metadata coverage.
    - COMMAND: vp run @pydantic/logfire-session-replay#typecheck
    - EXPECTED: No type errors.
    - COMMAND: vp run @pydantic/logfire-browser#test
    - EXPECTED: All browser tests pass with endpoint/config merge coverage.
    - COMMAND: vp run @pydantic/logfire-browser#typecheck
    - EXPECTED: No type errors.
    - COMMAND: vp run @pydantic/logfire-session-replay#build && vp run @pydantic/logfire-browser#build
    - EXPECTED: Both package artifacts build successfully.
    - COMMAND: pnpm run check
    - EXPECTED: The repository-wide release-oriented build, lint/check, typecheck, and test gate passes.
```

### Integration Points

```yaml
CONFIG:
  - packages/logfire-browser/src/index.ts — public trace/metric/replay endpoints become internal fetch/XHR auto-instrumentation ignores.
  - packages/logfire-browser/src/sessionReplay.ts — the same generated endpoint patterns become standalone replay ignoreUrlPatterns.

HOST PATCHING:
  - packages/logfire-session-replay/src/capture.ts — replay's fetch wrapper preserves the one-layer OTel exporter escape hatch while retaining patch ownership.

VALIDATION:
  - packages/logfire-browser/src/index.test.ts — lazy auto-instrumentation config boundary.
  - packages/logfire-browser/src/sessionReplay.test.ts — browser-to-replay config boundary.
  - packages/logfire-session-replay/src/capture.test.ts — wrapper/bypass boundary.
  - packages/logfire-browser/test-fixtures/self-observation — direct real-browser receipt/decode boundary.
```

## Validation

```bash
vp run @pydantic/logfire-session-replay#test
vp run @pydantic/logfire-session-replay#typecheck
vp run @pydantic/logfire-session-replay#build
vp run @pydantic/logfire-browser#test
vp run @pydantic/logfire-browser#typecheck
vp run @pydantic/logfire-browser#build
vp fmt --check packages/logfire-browser/src packages/logfire-session-replay/src plans/023-browser-telemetry-self-observation.md
pnpm run check
```

The executor must also run and record Task 5's exact Vite/agent-browser/receipt exercise for `CX-1`; package-unit evidence alone is insufficient. If the fixture is unavailable, the child remains unverified and cannot advance R1.

### Required Test Coverage

- [ ] Relative configured endpoint against canonical absolute fetch/XHR request.
- [ ] Raw relative request; nested path-relative resolution against both `globalThis.location.href` and a differing `document.baseURI`; absolute configuration; preserved exact trailing slash; replay trailing slash normalization and child path; exact trace/metric query/fragment; root exact endpoint; root/query/fragment replay rejection; application descendants; and sibling lookalike boundaries.
- [ ] User ignore string/regex preservation, disabled fetch/XHR instrumentation, and immutable nested config.
- [ ] Replay fetch wrapper over raw fetch and over OTel-shaped wrapped fetch, including exact `__original` descriptor and bypass.
- [ ] Later third-party wrapper ownership and idempotent replay stop remain green.
- [ ] Browser-integrated replay-before-auto and auto-before-replay controlled startup tests use installed OTel wrappers.
- [ ] Public real-browser configuration produces the named manual span, an FCP Web Vital metric, and replay receipts while replay is active; trace 1..6, metric 1..6, and replay 1..3 stay within bounds and no SDK request is observed.
- [ ] The one ordinary application request appears exactly once at the proxy, once in replay, and once as an HTTP client span.

### Consumer Verification Plan

| Scenario | Exercise                                                                                                                                                                                         | Expected observable evidence                                                                                                                                                               | Environment and prerequisites                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `CX-1`   | Build packages; run Task 5's Vite receipt fixture at `/nested/page/`; keep replay active through a fixed four-second window after trace, FCP metric, replay, and application receipts begin      | Trace 1..6, metric 1..6, and replay 1..3; decoded SDK endpoints are absent; named manual span and FCP metric exist; `/api/application` has exactly one proxy, replay, and span observation | Node 24, pnpm 11.5.2, built workspace packages, `vp dev` on loopback, agent-browser real browser, no credentials |
| `CX-2`   | Configure telemetry endpoints in replay ignoreUrlPatterns and replay upload URL in installed OTel fetch/XHR ignoreUrls; start standalone replay over OTel; select/call `__original`; stop replay | Underlying fetch receives exporter bypass directly; replay uploads are ignored by OTel; replay/OTel observers do not self-observe; stop preserves current owner                            | jsdom public replay test with installed OTel instrumentation; proxy limitation accepted                          |
| `CX-3`   | Configure public browser package with existing fetch/XHR ignore entries and one disabled instrumentation; run enabled installed constructors and inspect caller objects/spans                    | Existing application ignore behavior/disable state remains; SDK endpoints are ignored; original config references/values unchanged                                                         | Isolated jsdom public-config test; lazy browser timing limitation accepted and covered by CX-1/CX-5              |
| `CX-4`   | Exercise exact and replay-base endpoint kinds using raw relative URLs plus canonical URLs from differing nested `globalThis.location.href` and `document.baseURI`                                | Exact trailing/query semantics hold without suppressing descendants; replay children suppress correctly; root/query/fragment replay errors remain contained; lookalikes stay observable    | Deterministic public config/capture URL matrix in jsdom; real-browser representative covered by CX-1             |
| `CX-5`   | Gate public browser replay load and lazy auto-instrumentation completion in both orders using installed OTel constructors                                                                        | Generated ignores and observed application/SDK span behavior are identical in both orders                                                                                                  | Isolated jsdom with controlled promises; import timing is intentionally a proxy                                  |

If the direct real-browser environment is unavailable, grade `CX-1` `UNVERIFIED`; do not substitute jsdom and claim full verification.

## Unknowns & Risks

- The new repository-native Vite fixture must prove that the real browser emits `logfire.browser.web_vital.fcp` within its bounded setup. Failure to do so blocks the child; do not substitute another metric or infer suppression from configuration alone.
- Browser instrumentation evaluates parsed absolute URLs while replay sees raw fetch input. Incorrect deduplication or boundary construction could suppress a lookalike application path; exact negative tests are mandatory.
- Multiple third-party wrapper layers may not all follow OTel's single `__original` convention. This PRP guarantees the installed OTel contract, not arbitrary wrapper stacks.
- Dynamic auto-instrumentation and replay loading can race. Controlled installed-wrapper tests cover both orders; `CX-1` separately proves representative real-browser behavior.

**Confidence: 8/10** for one-pass implementation success. Runtime changes are bounded and source-backed; the remaining risk is deterministic Web Vitals metric production and OTLP/replay decoding in the new direct browser fixture.

## Execution Notes

### Scope Expansions

- Added `@opentelemetry/instrumentation-fetch` as a browser-package development dependency so installed-wrapper behavior is exercised directly rather than approximated.
- Added a repository-native Vite receipt fixture and two integration suites: standalone replay over installed OTel, and public browser `configure()` with controlled replay-first/auto-first completion.

### Execution Progress

- Started on 2026-07-13 at commit `f57d9ec`; preflight found no source drift and only the expected untracked planning/report artifacts.
- Implemented shared raw/exporter-canonical/document-canonical endpoint patterns, browser replay URL containment, immutable fetch/XHR ignore merging, and flattened replay fetch `__original` metadata.
- Completed focused unit/integration coverage and the direct nested-page browser receipt exercise.

### Deviations

- The browser fixture leaves the receipt window active after readiness; `verify.mjs` starts the required four-second post-evidence window and atomically freezes it through the fixture endpoint. This makes the specified observation boundary independent of host orchestration delay while preserving public cleanup after verification.
- The public startup-order test stubs the unrelated trace/metric exporters during cleanup; it still uses public `configure()`, installed OTel fetch instrumentation, and public replay startup. The real-browser fixture separately exercises the real exporters and Web Vitals path.

### Unresolved Risks

- None. Arbitrary third-party wrappers outside OTel's documented one-layer `__original` convention remain explicitly out of scope.

## Verification Record

### Consumer Acceptance

| Scenario | Grade | Evidence                                                                                                                                                                                                                 | Limitations                                                                         |
| -------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `CX-1`   | PASS  | Built public packages at `/nested/page/`; after evidence plus four active seconds: trace 2, metric 5, replay 1, FCP present, and `/api/application` exactly once at proxy/replay/span with no SDK endpoint observations. | Loopback fixture; no production credentials or forwarding.                          |
| `CX-2`   | PASS  | `selfObservation.integration.test.ts` uses public standalone replay plus installed `FetchInstrumentation` in both wrapper orders; exporter bypass, ignored uploads, one app span, and ownership cleanup pass.            | jsdom proxy accepted by the PRP.                                                    |
| `CX-3`   | PASS  | Public config tests preserve consumer ignores, disabled state, and caller immutability; installed instrumentation observes the application request but no SDK endpoint.                                                  | Exporter cleanup is stubbed in the isolated order test; CX-1 covers real exporters. |
| `CX-4`   | PASS  | URL/config matrices cover raw and dual canonical bases, absolute/invalid/empty/metacharacter inputs, exact trailing/query/fragment/root semantics, replay children, and contained invalid replay startup.                | Deterministic jsdom matrix as planned.                                              |
| `CX-5`   | PASS  | `browserConfigure.integration.test.ts` forces replay-first and auto-first completion through public `configure()` with installed OTel fetch instrumentation; both yield one application span and zero SDK spans.         | Controlled in-process timing as planned; CX-1 supplies real-browser evidence.       |

### Compliance and Engineering Review

- **PRP compliance**: PASS on 2026-07-13. A strict cold review initially found missing public-config startup ordering, an early observation-window boundary, and incomplete matrices; all three were corrected and the re-review returned PASS with no remaining findings.
- **Engineering review**: PASS on 2026-07-13. Independent acceptance and implementation reviews found no remaining correctness issue after rechecking replay URL filtering, wrapper flattening/ownership, config immutability, receipt decoding, and both startup orders.
- **Final validation**: PASS on 2026-07-13. `pnpm run check` passed all builds, formatting/lint/type gates, and tests: replay 100/100, browser 114/114, API 433/433, OTel CF 42 pass/5 skip, Node 80/80, and Logfire CF 4/4. The exact Vite/agent-browser exercise and public cleanup also passed with trace 2, metric 5, replay 1, FCP present, and the application request observed exactly once on all three surfaces.
