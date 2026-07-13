# PRP Roadmap: Browser RUM Stable-Release Remediation

## Status

- **Roadmap status**: ACTIVE
- **Created at commit**: `f57d9ec`
- **Planning baseline**: pre-existing untracked `plans/020-browser-rum-replay-lifecycle.md`, `reports/pr-161-review.md`, and `reports/pr-161-combined-review.md` must be preserved; roadmap research records are new planning artifacts.
- **Last updated**: 2026-07-13

## Outcome

Merge PR #161 only after the browser RUM and replay packages have a safe, documented stable contract; then use the normal Changesets workflow to publish official `@pydantic/logfire-browser@0.17.0` and `@pydantic/logfire-session-replay@0.1.0` packages and verify the resulting npm state.

## Why

- Browser integrators must not receive self-amplifying telemetry, silent span loss after lifecycle operations, replay loss under common unload/CSP conditions, or unsafe privacy and proxy defaults in the first stable replay release.
- Release operators need a deterministic Changesets plan with valid private-package metadata and secret-safe tooling before merging the feature branch into `main`.

## Roadmap Completion Criteria

- [ ] All blockers B1-B13 in `reports/pr-161-combined-review.md` are fixed with regression evidence.
- [ ] Stable-contract decisions D1-D4 are explicit, implemented, and documented; recovered header failures never become unauthenticated exports.
- [ ] Every should-fix item is either implemented and verified or has an explicit non-blocking follow-up disposition accepted before release.
- [ ] Public browser/replay, proxy/example, and release acceptance scenarios pass through their named evidence surfaces.
- [ ] The complete repository check and isolated Changesets version simulation pass with only the intended public versions and valid private-package versions.
- [ ] PR #161 and the generated Version Packages PR are reviewed and merged through the normal protected-branch workflow; npm `latest` resolves to the intended stable packages.
- [ ] The alpha branch is deleted only after the published packages and downstream handoff are verified.

## Explicitly Out of Scope

- Implementing the Platform changes described in the sibling `../platform` report; this roadmap only preserves and hands off the SDK contract.
- Changing the replay ingest envelope or backend schema.
- Deleting already published alpha package versions. Removing obsolete `alpha` dist-tags is a separate reversible operator choice.
- Refactoring unrelated OpenTelemetry packages or repository-wide release automation.
- Modifying or adopting the pre-existing untracked `plans/020-browser-rum-replay-lifecycle.md`.

## Consumer Contract

- **Consumer(s)**: browser SDK integrators, standalone replay integrators, host applications that already use OpenTelemetry, developers following the proxy/examples documentation, Logfire Platform as telemetry consumer, and npm release operators.
- **Public or supported boundaries**: `logfire.configure(...)`, manual `logfire.*` spans, `startSessionReplay(...)`, returned cleanup/replay handles, browser/replay option types, emitted page/session attributes and replay requests, documented proxy routes, package manifests/changesets, and npm dist-tags.
- **Current journey**: PR #161 prepares stable versions after alpha releases, but the combined review reproduces recursion, lifecycle, delivery, proxy, privacy, and release-integrity defects that make the candidate unsafe to merge.
- **Final observable promise**: supported browser telemetry and replay paths are bounded, host-safe, privacy-explicit, correctly authenticated, resilient to the documented lifecycle/CSP conditions, and published through a deterministic stable release.
- **Compatibility promise**: preserve existing documented browser/replay call shapes unless an explicitly settled D1-D4 decision changes a default or adds an API; never unregister application-owned OpenTelemetry globals; preserve the replay wire envelope and proxy-first deployment model.
- **Not claimed**: guaranteed delivery after browser termination, safety of exposing ingestion tokens directly to arbitrary browsers, automatic Platform sanitization, or support for unspecified OpenTelemetry multi-owner arrangements.

### End-to-End Acceptance Scenarios

| ID      | Given                                                                                                           | When                                                                          | Then                                                                                                                                                               | Evidence surface                                                                                     | Required evidence |
| ------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------- |
| `CX-1`  | Browser telemetry uses relative proxy URLs with auto-instrumentation and replay enabled                         | The SDK exports traces, metrics, and replay                                   | SDK export traffic is neither recorded into replay nor converted into new export-generating spans                                                                  | Public browser configuration with local OTLP/replay proxies and real fetch instrumentation           | DIRECT REQUIRED   |
| `CX-2`  | Configuration A has emitted manual and explicit-provider spans, or application-owned OTel globals already exist | The selected cleanup/reconfiguration or conflict journey is exercised         | Behavior matches the documented lifecycle contract, no span silently routes to a stopped provider, and application globals are never removed or disabled           | Public `configure()`/cleanup/manual span API plus real OTel providers and in-memory exporters        | DIRECT REQUIRED   |
| `CX-3`  | Replay has multiple unload chunks and periodic worker compression is blocked by CSP                             | The page hides or ordinary replay flush runs                                  | Every request permitted by the aggregate keepalive budget starts before response waiting; ordinary batches fall back to valid synchronous gzip without loss        | Real browser with delayed local replay proxy and `worker-src 'none'` fixture                         | DIRECT REQUIRED   |
| `CX-4`  | Optional replay callbacks, error reporters, replay state getters, or metrics header resolvers throw or reject   | Timers, rrweb callbacks, span start, or metric export invoke them             | Host application control flow remains intact, the affected observation/export fails safely, and no authenticated request is retried without required headers       | Public SDK tests with real timers/export boundary and rejection tracking                             | DIRECT REQUIRED   |
| `CX-5`  | A page contains sensitive query/fragment values, visible text, console data, and navigation changes             | Browser session/replay runs with the selected defaults and explicit overrides | Captured attributes and replay events exactly match the settled privacy contract, including navigation redaction and example-side-channel behavior                 | Public browser/replay configuration with decoded spans and replay envelopes                          | DIRECT REQUIRED   |
| `CX-6`  | A developer follows the documented local proxy setup for telemetry and replay                                   | The browser sends valid, oversized, or upstream-failing requests              | Supported routes forward correctly; invalid/oversized/upstream-failing requests return bounded 4xx/5xx responses; token injection is loopback/origin restricted    | Runnable documentation/example proxy with local fake upstream                                        | DIRECT REQUIRED   |
| `CX-7`  | Browser examples encounter rejected catalog/XHR/checkout/basic fetch operations                                 | A user triggers the workflow                                                  | Loading state ends and a visible failure state appears without an unhandled rejection                                                                              | Running example through its public UI or a faithful browser test                                     | DIRECT REQUIRED   |
| `CX-8`  | A consumer adopts browser-integrated replay and Web Vitals                                                      | They use the settled public placement, lifecycle, and degradation behavior    | Types, runtime behavior, README, browser docs, and changelog describe one consistent stable contract                                                               | Pack/test a minimal documented consumer against built packages                                       | DIRECT REQUIRED   |
| `CX-9`  | The remediation changesets and private package versions are present in exit mode                                | A release operator runs status and an isolated version operation              | The public plan is exactly browser `0.17.0` and replay `0.1.0`; no manifest or changelog contains a null version; npm token input is absent from process arguments | Installed Changesets 2.30.0 in a disposable detached simulation plus script-level process inspection | DIRECT REQUIRED   |
| `CX-10` | All implementation and CI gates are green on PR #161                                                            | The feature PR and generated Version Packages PR merge                        | npm `latest` resolves to the official versions, package contents/imports are correct, and the alpha branch can be deleted without losing work                      | GitHub checks/releases and npm registry/package smoke test                                           | DIRECT REQUIRED   |

## Evidence and Decisions

### Vetted Findings

- `reports/pr-161-combined-review.md` — consolidates reproduced blockers B1-B13, stable decisions D1-D4, the unsafe header-fallback proposal X1, should-fixes, and the release gate. — **Roadmap impact**: this is the finding inventory and disposition source of truth.
- `packages/logfire-browser/src/index.ts:477-492,539-601` and `packages/logfire-api/src/logfireApiConfig.ts:86-99,126-129` — current cleanup shuts down a concrete provider without replacing globals or rebinding the cached manual tracer. — **Roadmap impact**: lifecycle/ownership requires a separate architectural child.
- `packages/logfire-session-replay/src/transport.ts:78-105` — response-serial chunk delivery starts only one unload request at a time. — **Roadmap impact**: delivery requires aggregate-budget scheduling and a real page-lifecycle test.
- `packages/logfire-session-replay/src/transport.ts:309-318` — asynchronous worker compression has no synchronous fallback. — **Roadmap impact**: CSP degradation must preserve the same batch.
- Installed Changesets 2.30.0 simulation — versionless `examples/nextjs` can become `"version": null`. — **Roadmap impact**: private manifest normalization is a precondition for the stable version operation.

### Settled Decisions and Invariants

- **OpenTelemetry ownership**: never blindly call `trace.disable()`, `context.disable()`, or `propagation.disable()` during cleanup because the public APIs cannot identity-check all current owners. — **Evidence**: Spike 01.
- **Unload delivery**: retain authenticated gzip fetch; schedule only compressed bodies that fit a conservative aggregate keepalive budget, without serial response waiting. Delivery remains best effort. — **Evidence**: Spike 02 and the WHATWG Fetch keepalive quota.
- **CSP compression**: retain input bytes, fall back to `gzipSync`, memoize deterministic worker unavailability, and report only if both paths fail. — **Evidence**: Spike 03.
- **Metrics credentials**: decline X1's empty-header fallback; a header resolver failure is a contained failed export, never an unauthenticated retry. — **Evidence**: installed exporter containment behavior and the combined review.
- **Release path**: use feature PR -> Changesets Version Packages PR -> normal publish workflow. Do not publish stable packages directly from the feature branch. — **Evidence**: repository workflow and completed PRP 022 release mechanics.
- **Retry boundary**: ordinary replay delivery treats HTTP 429 as transient and honors a valid bounded `Retry-After`; keepalive/unload delivery remains one attempt. — **Evidence**: existing retry split and unload time constraints.
- **Web Vitals span semantics**: Web Vitals spans are point-in-time events and must carry `logfire.span_type = 'log'`. Platform RUM queries select `web_vital.*` names/attributes, so this preserves their aggregate/drilldown contract. R6 owns implementation and exact tests.
- **Vite+ test import**: decline cleanup item 19 as obsolete. `capture.test.ts` uses the supported `vite-plus/test` entrypoint and passes the current Vite+ test gate; no functional release defect was established, so preserve it as-is. No child owns changing the import.

Pending decisions before this roadmap can become ACTIVE:

- Same-page reconfiguration uses a page-stable non-caching delegating tracer provider. Only one configuration generation may be active per package instance; cleanup must settle before the next configure call.
- D1 default page URL value.
- D2 default visible-text masking and the exact console/network/navigation privacy posture.
- D3 whether browser integration exposes a replay lifecycle handle in this release.
- D4 whether `sessionReplay` remains top-level or moves under `rum` before stable publication.
- Whether metrics startup failure degrades to Web Vitals spans only; the recommended behavior is spans-only degradation with an explicit diagnostic.

### Roadmap-Level Spikes

- `plans/research/roadmaps/001-browser-rum-release-remediation/spike-01-otel-reconfiguration.md` — **Result**: current reconfiguration silently splits telemetry; safe global teardown is unavailable; stable delegation is feasible. — **Limits**: real-browser async context and duplicate-bundle compatibility remained for Spike 04/child disposition.
- `plans/research/roadmaps/001-browser-rum-release-remediation/spike-02-unload-keepalive-policy.md` — **Result**: serial starts lose later chunks, while unconstrained concurrency exceeds a shared 64 KiB quota; Beacon cannot preserve the transport contract. — **Limits**: real page-freeze behavior remains child evidence.
- `plans/research/roadmaps/001-browser-rum-release-remediation/spike-03-csp-gzip-fallback.md` — **Result**: retained bytes can fall back to synchronous gzip after setup or callback failure. — **Limits**: actual CSP enforcement remains child evidence.
- `plans/research/roadmaps/001-browser-rum-release-remediation/spike-04-delegating-provider-contract.md` — **Result**: non-caching per-span delegation preserves cached tracers across generations and independently preserves application-owned globals; duplicate package reconfiguration is unsupported because copies may share mutable core config. — **Limits**: real provider resources, Zone context, and delayed spans remain child evidence.

### Compatibility and Rollback Contract

- **Reversible boundary**: before PR #161 merges, every runtime/default/API change remains removable from the feature branch and alpha packages remain the only published versions.
- **New data under rollback**: replay envelope and span key schema remain compatible; privacy-default changes affect value content, not field shape. Proxy changes retain the same routes.
- **Mixed-version behavior**: Platform continues to prefer `logfire.page.url.*` and may receive old alpha raw values or new stable sanitized values; package consumers must install compatible browser/replay versions declared by the optional peer range.
- **Destructive boundary**: merging the Version Packages PR and publishing moves npm `latest`. Authorization requires green integrated evidence, valid generated changelogs/manifests, and a package smoke test. Historical alpha artifacts remain available for rollback.

### Validation Baseline

| Surface or command                             | Status                 | Observed result                                                                                                                    |
| ---------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `vp run @pydantic/logfire-session-replay#test` | Verified               | 8 files, 95 tests passed at `f57d9ec`                                                                                              |
| `vp run @pydantic/logfire-browser#test`        | Verified               | 6 files, 90 tests passed at `f57d9ec`                                                                                              |
| `node_modules/.bin/changeset status --verbose` | Baseline failing       | Intended public versions plus private `examples/nextjs` null-version artifact and private nextjs-client-side-instrumentation patch |
| `pnpm run check`                               | Discovered but not run | Required after implementation                                                                                                      |
| Real-browser delayed unload proxy              | Discovered but not run | Required by `CX-3`                                                                                                                 |
| Real-browser restrictive-CSP replay flush      | Discovered but not run | Required by `CX-3`                                                                                                                 |

## Decomposition Strategy

The roadmap separates stable contracts by independent consumer-visible failure boundary: telemetry recursion, OpenTelemetry ownership, replay delivery, host containment, privacy, public optional-feature API, proxy/examples, release integrity, and final integration/publication. Each child can be implemented and validated without concurrently modifying another child; the final checkpoint exercises their interactions before release.

## Dependency Map

- `R1` -> `R9`: recursion-free exports are required for the integrated browser journey.
- `R2` -> `R6`: lifecycle ownership determines which cleanup/handle promises the public integration can document.
- `R3` -> `R9`: the delivery child produces the keepalive/CSP contract used by the final real-browser gate.
- `R4` -> `R9`: containment and bounded-runtime guarantees are prerequisites for host-safe integration.
- `R5` -> `R6`: privacy decisions determine public option defaults and documentation.
- `R6` -> `R9`: the settled stable API/degradation contract is consumed by the package smoke test.
- `R7` -> `R9`: working secure proxies/examples provide the outside-in browser validation environment.
- `R8` -> `R9`: valid release metadata and tooling are prerequisites for the version PR and publication.

## Outcome Coverage

| Required outcome, `CX-N`, or contract               | Producing step | Verification checkpoint                   |
| --------------------------------------------------- | -------------- | ----------------------------------------- |
| Recursion-free telemetry; `CX-1`                    | R1             | After R1 and final R9 browser integration |
| OTel lifecycle ownership; `CX-2`                    | R2             | After R2 and R9 package smoke test        |
| Unload/CSP replay delivery; `CX-3`                  | R3             | After R3 real-browser gate and R9         |
| Host containment and bounded replay runtime; `CX-4` | R4             | After R4 and R9 combined configuration    |
| Privacy/redaction contract; `CX-5`                  | R5             | After R5 decoded telemetry/replay check   |
| Stable integration API; `CX-8`                      | R6             | After R6 minimal consumer and R9          |
| Secure proxies and failure UX; `CX-6`, `CX-7`       | R7             | After R7 running examples and R9          |
| Deterministic release plan; `CX-9`                  | R8             | After R8 detached version simulation      |
| Official stable publication; `CX-10`                | R9             | Post-publish npm and GitHub verification  |

## Steps

### R1: Prevent SDK telemetry from observing itself

- **Status**: VERIFIED
- **Outcome**: browser exports are excluded from replay capture and fetch instrumentation for relative and absolute endpoint configuration.
- **Why separate**: recursion is a bounded correctness contract with a focused integration surface.
- **Depends on**: None.
- **Produces**: canonical endpoint matching and wrapper metadata preservation used by final integration.
- **Consumer impact**: owns `CX-1`.
- **External readiness inputs**: local trace/metric/replay proxy; no credentials.
- **Must preserve**: custom ignore patterns, third-party wrapper coexistence, request semantics.
- **In scope**: B1, B2, absolute URL normalization, `fetch.__original`, instrumentation ignore integration, regression tests.
- **Out of scope**: replay payload privacy and OTel provider lifecycle.
- **Validation boundary**: public browser configuration with auto-instrumentation and replay against local endpoints produces bounded request counts and no captured SDK requests.
- **Remaining questions**: None; endpoint-kind semantics, both browser URL bases, replay URL validation, and standalone owner obligations are settled in the child.
- **Child PRP**: `plans/023-browser-telemetry-self-observation.md` — cold-reviewed READY on 2026-07-13.
- **Completion evidence**: PRP 023 verified on 2026-07-13. `pnpm run check` passed (browser 114/114; replay 100/100), two independent cold reviews passed, and the built public-package browser fixture held replay active for four seconds after required evidence, then reported trace 2, metric 5, replay 1, FCP present, zero SDK self-observation, and exactly one application proxy/replay/span observation.

### R2: Establish an ownership-safe browser provider lifecycle

- **Status**: VERIFIED
- **Outcome**: cleanup and subsequent configuration follow one explicit contract without silent span loss or application-global clobbering.
- **Why separate**: provider ownership is architectural and affects manual tracers, instrumentations, resources, sampling, context, duplicate-bundle limitations, and public cleanup semantics.
- **Depends on**: stable delegation selected by the user; Spikes 01 and 04 complete.
- **Produces**: stable provider-generation or terminal-cleanup contract consumed by R6 and R9.
- **Consumer impact**: owns `CX-2` and enables `CX-8`.
- **External readiness inputs**: real OpenTelemetry providers/exporters; real-browser async-context fixture if delegation is selected.
- **Must preserve**: application-owned globals; manual and explicit-provider telemetry alignment.
- **In scope**: B3, real-registry characterization tests, tracer rebinding/delegation or deterministic refusal, conflict behavior.
- **Out of scope**: metrics global ownership unless child research proves it is coupled.
- **Validation boundary**: selected lifecycle scenario passes through public configure/cleanup/manual span APIs and custom instrumentation.
- **Remaining questions**: None; lifecycle state, cleanup failure, mixed global ownership, context rollback, span cutoff, and duplicate-package limitations are settled in the child.
- **Child PRP**: `plans/024-browser-provider-reconfiguration.md` — cold-reviewed READY on 2026-07-13.
- **Completion evidence**: PRP 024 verified on 2026-07-13. The browser suite passed 136/136 tests, public real-API coverage passed all eight mixed trace/context/propagation ownership combinations, `pnpm run check` passed, and both built-package Zone/browser receipt scenarios passed with exact A/B routing, public manual helpers, explicit instrumentation, B sampling, inactive no-op behavior, and application-global survival. A post-implementation cold review passed after its three findings were fixed.

### R3: Preserve replay delivery across unload and restrictive CSP

- **Status**: VERIFIED
- **Outcome**: permitted unload chunks start within aggregate quota and ordinary batches survive worker-compression failure.
- **Why separate**: browser lifecycle and compression require direct browser evidence distinct from capture/privacy behavior.
- **Depends on**: Spikes 02 and 03.
- **Produces**: bounded keepalive scheduler, compression degradation contract, and real-browser fixture.
- **Consumer impact**: owns `CX-3`.
- **External readiness inputs**: local delayed replay proxy and browser runner capable of CSP headers.
- **Must preserve**: authenticated gzip fetch, sequence allocation, one-attempt unload semantics, replay envelope.
- **In scope**: B4, B5, byte-accurate buffer/keepalive estimates, UTF-8 request-body byte accounting in `capture.ts` with a non-ASCII assertion, ordinary 429 retry/`Retry-After`, unload credential caveat.
- **Out of scope**: guaranteed delivery beyond browser quota; wire-format changes.
- **Validation boundary**: decoded local proxy receipts plus restrictive-CSP browser smoke, exact multibyte `reqBytes` capture assertions, and focused unit tests.
- **Remaining questions**: None; the child settles a transport-wide 48,000-byte reservation budget across unfinished keepalive requests, one-attempt best-effort normal fetch for excess lifecycle chunks, per-transport CSP fallback memoization, and a 10-second maximum accepted `Retry-After` delay, with longer valid guidance stopping retries rather than being clamped downward.
- **Child PRP**: `plans/025-replay-delivery-reliability.md` — cold-reviewed READY on 2026-07-13.
- **Completion evidence**: PRP 025 verified on 2026-07-13. Focused replay tests passed (128/128), browser protection passed (136/136), root `pnpm run check` passed, and direct built-package fixture receipts passed: genuine navigation started two authenticated contiguous unload requests before held-response release (41,334 compressed bytes total, <=48,000), actual `worker-src 'none'` produced one blocked worker attempt with two decoded batches and zero errors, 429 recovery preserved seq/body/authentication across a 1,002 ms retry delay, and native fetch/XHR UTF-8 receipts plus decoded replay events reported 6 bytes. R3's delivery and async-credential documentation contract is ready for R6 preservation/review and R9 integration.

### R4: Contain optional-feature failures and replay backpressure

- **Status**: READY FOR PRP
- **Outcome**: hostile callbacks and optional-module failures cannot escape into host application control flow, while buffers and error reporting remain bounded.
- **Why separate**: host-safety is independently testable without changing privacy defaults or release metadata.
- **Depends on**: None.
- **Produces**: guarded callback/error boundary and bounded replay buffer contract.
- **Consumer impact**: owns `CX-4`.
- **External readiness inputs**: None.
- **Must preserve**: explicitly documented synchronous public-method errors; authenticated-export failure semantics.
- **In scope**: B10, X1 containment, active re-check, buffer-mode cap, bounded/debounced session-activity persistence for rrweb events and span starts, onError/console reentrancy, rejection coercion, replay-state getter guards, empty URL validation, storage failure behavior, exact touched tests.
- **Out of scope**: metrics degradation policy and privacy defaults.
- **Validation boundary**: public calls/timers/rrweb/export callbacks with throwing and rejecting consumers produce no host exception or unhandled rejection; a fake-clock storage probe proves activity writes are bounded while in-memory expiry remains current.
- **Remaining questions**: identify any public synchronous methods whose throw is intentional during child research.
- **Child PRP**: Not generated.
- **Completion evidence**: Pending.

### R5: Set and enforce replay/page privacy defaults

- **Status**: BLOCKED
- **Outcome**: page attributes, navigation, DOM text, console, and network capture obey one explicit stable privacy contract with safe examples.
- **Why separate**: default data collection is a public product/security choice, not an implementation detail.
- **Depends on**: user decisions D1 and D2.
- **Produces**: stable default/override matrix and decoded payload evidence consumed by R6/R9 and Platform handoff.
- **Consumer impact**: owns `CX-5`.
- **External readiness inputs**: representative page fixture containing query, fragment, visible text, inputs, console data, and navigation.
- **Must preserve**: configurable overrides and documented direct-token warning.
- **In scope**: D1, D2, B11, B13, masking/redaction options, docs/tests/examples, Platform report consistency.
- **Out of scope**: Platform implementation and backend scrubbing.
- **Validation boundary**: inspect exact exported span attributes and decompressed replay events under defaults and explicit opt-ins.
- **Remaining questions**: D1 URL default and D2 visible-text/side-channel default.
- **Child PRP**: Not generated.
- **Completion evidence**: Pending.

### R6: Finalize browser optional-feature API and degradation contract

- **Status**: BLOCKED
- **Outcome**: replay/Web Vitals placement, lifecycle access, and startup-degradation behavior form one documented, typed stable API.
- **Why separate**: API placement and exposed handles can become long-lived stable commitments.
- **Depends on**: R2 lifecycle contract, R5 privacy option contract, and user decisions D3/D4/metrics degradation.
- **Produces**: package types, docs, changelog contract, and minimal-consumer fixture.
- **Consumer impact**: owns `CX-8`.
- **External readiness inputs**: built package tarballs or workspace-packed equivalents.
- **Must preserve**: optional lazy loading, backward compatibility for accepted alpha call shapes unless explicitly changed before stable.
- **In scope**: D3, D4, metrics-failure degradation, late Web Vitals callback diagnostics, exact `logfire.span_type = 'log'` on Web Vitals point events, documentation that browser-session inactivity currently means span inactivity, dead public/internal surface disposition, and preservation/review of R3's async replay credential caveat across the final API documentation.
- **Out of scope**: provider internals owned by R2 and proxy implementation.
- **Validation boundary**: typecheck and run a minimal documented consumer against built package outputs; assert Web Vitals span type exactly and verify the documented span-inactivity definition.
- **Remaining questions**: D3, D4, and spans-only Web Vitals degradation decision.
- **Child PRP**: Not generated.
- **Completion evidence**: Pending.

### R7: Make documented proxies and examples safe and truthful

- **Status**: READY FOR PRP
- **Outcome**: the documented development proxy supports its claimed routes and examples fail visibly without exposing token-injecting servers broadly.
- **Why separate**: Node proxy/server and browser UI validation are independent from SDK runtime internals.
- **Depends on**: R5 supplies final privacy wording before completion, but implementation can begin with the existing route contract.
- **Produces**: secure local proxy contract and runnable outside-in example environment for R9.
- **Consumer impact**: owns `CX-6` and `CX-7`.
- **External readiness inputs**: local fake upstream; browser runner.
- **Must preserve**: development-only proxy posture and separate Python telemetry/replay capabilities.
- **In scope**: B7-B9, loopback binding, explicit origin allow-list, 413/502 behavior, query encoding, example rejected-action UX, build prerequisite and `.env.example` guidance, default URL review.
- **Out of scope**: production proxy deployment or modifying the Python Logfire repository.
- **Validation boundary**: exercise valid, oversize, and failed-upstream requests plus example error UI through running servers.
- **Remaining questions**: exact documentation form for a separate Python replay relay; no SDK architecture dependency.
- **Child PRP**: Not generated.
- **Completion evidence**: Pending.

### R8: Reconcile Changesets and release tooling

- **Status**: READY FOR PRP
- **Outcome**: release metadata produces only valid intended versions and npm credentials never appear in command arguments.
- **Why separate**: release-plan correctness is independently simulatable and should not be mixed with runtime fixes.
- **Depends on**: final package-visible change inventory before completion; implementation can normalize the private manifest and token input immediately.
- **Produces**: valid changesets/changelogs/manifests and secret-safe release helper consumed by R9.
- **Consumer impact**: owns `CX-9`.
- **External readiness inputs**: installed Changesets 2.30.0; disposable detached simulation; no live npm token.
- **Must preserve**: normal protected-branch Changesets workflow and intended browser/replay versions.
- **In scope**: B6, B12, private Next.js version, changelog coverage, deterministic test assertion cleanup touching release work, bounded generated-artifact inspection.
- **Out of scope**: publishing or modifying unrelated package versions.
- **Validation boundary**: detached `changeset version` simulation and process-argument test produce valid expected output.
- **Remaining questions**: final changeset prose after upstream children complete.
- **Child PRP**: Not generated.
- **Completion evidence**: Pending.

### R9: Integrate, merge, and publish the official stable release

- **Status**: BLOCKED
- **Outcome**: all contracts work together, CI/reviews are green, official packages are published, and the feature branch is safely retired.
- **Why separate**: integration and publication cross irreversible external checkpoints and cannot be validated by any one implementation child.
- **Depends on**: verified R1-R8 outputs and all roadmap decisions settled.
- **Produces**: merged feature/version PRs, GitHub releases/tags, npm stable packages, downstream handoff, deleted alpha branch.
- **Consumer impact**: owns `CX-10` and rechecks `CX-1`-`CX-9` interactions.
- **External readiness inputs**: green GitHub checks/reviews, repository merge rights, npm trusted publishing/token workflow, registry access.
- **Must preserve**: rollback through historical alpha packages and no direct feature-branch publish.
- **In scope**: full `pnpm run check`, package pack/import smoke, CodeRabbit disposition, PR merges, Version Packages review, npm/GitHub verification, optional alpha dist-tag decision, branch deletion.
- **Out of scope**: downstream Platform code changes.
- **Validation boundary**: public registry/package consumer plus GitHub release checks after each authorized checkpoint.
- **Remaining questions**: release-time operator approval at each external mutation and optional alpha dist-tag removal.
- **Child PRP**: Not generated; release runbook child generated only after R1-R8 verify.
- **Completion evidence**: Pending.

## Integration Checkpoints

### After R1-R4

- **Integrated behavior to validate**: recursion prevention, replay delivery, and failure containment coexist under one browser configuration.
- **Consumer scenarios**: `CX-1`, `CX-3`, `CX-4`.
- **Commands or observation**: focused package tests plus local proxy/browser fixture with auto-instrumentation, replay, delayed responses, and CSP.
- **Evidence requirement**: DIRECT REQUIRED for request counts/contents; browser fixture required for unload/CSP.
- **Decision enabled**: runtime core is safe to combine with settled privacy/API defaults.

### After R5-R8

- **Integrated behavior to validate**: documented configuration, examples, package types, changesets, and changelog describe the same stable contract.
- **Consumer scenarios**: `CX-5`-`CX-9`.
- **Commands or observation**: decoded telemetry/replay, running examples/proxies, packed minimal consumer, detached Changesets simulation.
- **Evidence requirement**: DIRECT REQUIRED.
- **Decision enabled**: authorize final integration and feature PR merge.

### After R9 publication

- **Integrated behavior to validate**: registry packages reproduce the verified packed behavior and normal release metadata exists.
- **Consumer scenarios**: `CX-10`, with smoke rechecks of `CX-1`, `CX-5`, and `CX-8`.
- **Commands or observation**: npm metadata/tarball inspection, clean minimal install/import, GitHub tags/releases, downstream handoff note.
- **Evidence requirement**: DIRECT REQUIRED.
- **Decision enabled**: delete the alpha branch; separately decide whether to remove historical `alpha` dist-tags.

## Risks and Replanning Triggers

- Stable delegation cannot preserve real-browser async context or sampling/resource changes, or the required duplicate-package limitation proves unacceptable for stable release.
- Aggregate keepalive budgeting cannot be exercised in the available browser runner or conflicts with unrelated page keepalive traffic beyond the accepted best-effort contract.
- Privacy decisions require a new wire schema or backend support rather than configuration/default changes.
- Child research reveals that one step owns multiple inseparable public outcomes or cannot pass independently; split or reorder it before generating the PRP.
- Changesets proposes any unintended public version, null version, or incompatible optional-peer range after all package-visible changes are included.
- CI, CodeRabbit, or external review finds a new stable-release blocker; add it to the finding inventory and reassess only affected children.

## Progress Log

### 2026-07-13

- Reconciled the combined review with completed PRP 022 and current source at `f57d9ec`.
- Routed the work from one oversized PRP to a roadmap because it contains multiple public decisions, independent implementation outcomes, and validation environments.
- Generated `plans/025-replay-delivery-reliability.md` for R3 after resolving the aggregate keepalive budget, lifecycle/excess-attempt policy, CSP memoization scope, and bounded `Retry-After` behavior; assigned implementation and browser-doc ownership of the async credential caveat to R3 while R6 preserves/reviews the resulting contract.
- Cold-reviewed PRP 025 to READY after tightening server-respecting retry bounds, transport-wide overlapping keepalive reservations, response end-of-body capacity release, deterministic real-browser fixture events, exact protected-baseline attribution, and cross-child ownership.
- Completed and recorded three roadmap-level spikes for OpenTelemetry ownership, unload keepalive scheduling, and CSP-safe compression fallback.
- Marked R1, R3, R4, R7, and R8 ready for child-PRP research; R2, R5, R6, and R9 remain blocked on explicit contracts or upstream verification.
- Generated and cold-reviewed `plans/023-browser-telemetry-self-observation.md`; R1 is implementation-ready with a fail-closed real-browser receipt gate.
- Selected stable delegating-provider reconfiguration, completed the exact lifecycle-contract spike, and unblocked R2 for its child PRP.
- Generated and cold-reviewed `plans/024-browser-provider-reconfiguration.md`; R2 is implementation-ready with public eight-case ownership coverage and direct Zone/browser receipts.
- Reconciled the secondary roadmap review: assigned Web Vitals span type and inactivity semantics to R6, session-storage write debouncing to R4, UTF-8 captured request-body sizing to R3, and dispositioned the stale `vitest` import suggestion as obsolete after the Vite+ migration.
- Executed and verified PRP 023 for R1: canonical endpoint suppression, replay fetch metadata, public both-order startup coverage, and the direct four-second browser receipt gate all pass.
- Executed and verified PRP 024 for R2: page-stable delegation, ownership-safe globals, terminal cleanup/rollback behavior, public A/inactive/B routing, all eight mixed-ownership cases, and both direct Zone/browser receipt scenarios pass.
