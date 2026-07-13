# Preserve Replay Delivery Across Unload and Restrictive CSP

## Goal

Make browser session replay delivery bounded and resilient: start every lifecycle upload admitted by a conservative transport-wide in-flight keepalive budget before waiting for responses, preserve one-attempt lifecycle semantics, recover ordinary batches when CSP blocks fflate's worker compressor, retry ordinary 429 responses according to a bounded `Retry-After` policy, and count string payloads in UTF-8 bytes.

## Why

- The current response-serial unload loop can start only the first chunk before page freeze, so the large-buffer path loses chunks precisely when lifecycle delivery is needed.
- A document with `worker-src 'none'` blocks fflate's Blob-backed worker; the current ordinary flush has already removed the batch from memory when compression fails and sends nothing.
- Replay 429 responses are treated as permanent 4xx failures, and string sizes are measured as UTF-16 code units rather than transmitted UTF-8 bytes.
- Browser-facing examples use asynchronous replay credentials without carrying forward the standalone package's page-freeze warning.

## Success Criteria

- [ ] Lifecycle flushing uses actual compressed body sizes and starts all sequence-ordered chunks admitted by a transport-wide 48,000-byte in-flight keepalive budget without response-serial waiting; overlapping flushes share reservations and completed requests reclaim capacity.
- [ ] Lifecycle intent is independent of `RequestInit.keepalive`; every lifecycle chunk is attempted at most once, including an over-budget chunk attempted with normal fetch.
- [ ] Ordinary batches fall back from fflate async gzip to valid `gzipSync` output over the retained input, memoize worker unavailability for the transport, and report an error only if both compression paths fail.
- [ ] Ordinary 429 responses retry within the existing three-attempt limit, honor valid seconds or HTTP-date `Retry-After` values up to 10,000 ms, stop rather than retry early when valid guidance exceeds that bound, and retain the existing backoff for absent or invalid values.
- [ ] Replay buffer/chunk estimates and captured fetch/XHR string request bodies use UTF-8 byte counts; `"é🚀"` is reported as exactly 6 bytes.
- [ ] The standalone and integrated browser documentation accurately describe best-effort unload, aggregate quota competition, CSP fallback, and the asynchronous credential limitation.
- [ ] A built-public-package browser fixture directly proves genuine navigation scheduling, restrictive-CSP recovery and memoization, 429 recovery, and exact UTF-8 network events through decoded local receipts.

## Roadmap Context

- **Parent roadmap**: `plans/roadmaps/001-browser-rum-release-remediation.md`
- **Roadmap step**: `R3` — permitted unload chunks start within aggregate quota and ordinary batches survive worker-compression failure.
- **Satisfied dependencies**: conclusive `plans/research/roadmaps/001-browser-rum-release-remediation/spike-02-unload-keepalive-policy.md` and `plans/research/roadmaps/001-browser-rum-release-remediation/spike-03-csp-gzip-fallback.md`; verified R1 self-observation and R2 provider-lifecycle work form the protected integration baseline.
- **Inherited decisions and invariants**: authenticated gzip fetch; the versioned replay envelope and sequence allocation; no response-serial waiting between admitted lifecycle requests; exactly one attempt for every lifecycle-triggered chunk; no guaranteed termination delivery; successful CSP fallback is normal degradation; no input-consuming compression transfer.
- **Contract produced for later steps**: the bounded replay delivery and credential-documentation contract consumed by R6, plus the real-browser `CX-3` fixture and evidence consumed by R9.

## Consumer Contract

### Consumer and Public Boundary

- **Consumer(s)**: standalone replay integrators, browser SDK integrators, and applications deploying replay behind authenticated local proxies and restrictive Content Security Policies.
- **Public or supported boundary**: `startSessionReplay(...)`, its returned `flush()`/`stop()` handle, browser `logfire.configure({ sessionReplay: ... })`, authenticated gzip POSTs to `{replayUrl}/{sessionId}?seq={seq}`, `NetworkPayload.reqBytes`, and the browser/replay guides.
- **Entry point and prerequisites**: a browser page with the public built replay package, a replay URL, optional functional headers/token, and a same-origin fixture proxy for direct verification.
- **Current observable behavior**: lifecycle chunks wait for preceding responses; over-budget lifecycle bodies silently acquire the ordinary retry policy; ordinary fflate worker failures drop detached batches; 429 is nonretryable; multibyte strings are undercounted.
- **Observable promise**: lifecycle delivery makes a bounded best-effort start of the earliest compressed chunks before response waiting without self-overcommitting across overlapping flushes, ordinary delivery survives deterministic worker rejection, short server retry guidance is respected, and byte metadata matches the UTF-8 body on the wire.
- **Must remain compatible with**: `@pydantic/logfire-session-replay` 0.1.0-alpha.1 public call shapes, fflate 0.8.3, rrweb 2.1.0, the version-1 replay envelope, persisted sequence numbers, proxy-first authentication, direct-token escape hatch, R1's installed-wrapper/ignore semantics, and R2's browser cleanup ordering.
- **Not claimed**: guaranteed delivery after page termination; exclusive access to the browser's shared keepalive quota; delivery of all over-budget replay; cross-browser behavior beyond the verified runner; direct-browser token safety; or a new public retry/budget configuration API.

### Acceptance Scenarios

| ID                      | Given                                                                                                                                                                 | When                                                                                                          | Then                                                                                                                                                                                                        | Evidence surface                                                             | Required evidence                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `CX-1` / parent `CX-3a` | Public standalone replay has at least two separately observed, ordered chunks whose compressed bodies together fit 48,000 bytes and synchronous marker authentication | The user follows a normal link, genuine `pagehide` fires, and the local replay proxy withholds every response | Both authenticated, sequence-numbered gzip requests reach the proxy before any response is released; each decoded chunk contains its distinct expected marker and their event union is complete and ordered | Built public package, real browser navigation, delayed local proxy           | DIRECT REQUIRED — unit mocks cannot prove lifecycle/browser scheduling                                                            |
| `CX-2` / parent `CX-3b` | `Worker` is available but the document is served with actual `worker-src 'none'`                                                                                      | The consumer performs two ordinary public `replay.flush()` calls                                              | Both original batches arrive as valid gzip; fallback emits no `onError`; only the first flush attempts the blocked worker path                                                                              | Restrictive-CSP browser page, policy-violation state, decoded local receipts | DIRECT REQUIRED — CSP enforcement must be browser-real                                                                            |
| `CX-3`                  | Ordinary replay delivery receives 429 with `Retry-After: 1`                                                                                                           | The public consumer awaits `replay.flush()`                                                                   | The identical authenticated sequence/body is attempted again no earlier than the instructed delay and succeeds; a lifecycle 429 remains one attempt                                                         | Built public package with scripted local proxy; focused fake-clock matrix    | DIRECT REQUIRED for recovery; PROXY ACCEPTABLE for date grammar/cap/error matrix because elapsed parser behavior is deterministic |
| `CX-4`                  | Replay network capture is enabled                                                                                                                                     | The page sends native fetch and XHR string bodies `"é🚀"` and flushes through the public handle               | Decoded `logfire.network` events report `reqBytes: 6`, matching the exact bytes observed by the application endpoint                                                                                        | Built public package, native browser fetch/XHR, decoded replay receipt       | DIRECT REQUIRED — confirms capture and transport integration                                                                      |
| `CX-5`                  | An integrator reads either supported browser replay guide or the standalone replay guide                                                                              | They inspect lifecycle constraints and the supported replay control surface                                   | The docs disclose per-upload credential resolution, async page-freeze risk, shared-quota/best-effort delivery, and CSP fallback without advertising an unavailable integrated replay handle                 | Documentation and built type-surface inspection                              | DIRECT REQUIRED — the published documentation/type boundary is inspected directly                                                 |

## Research Summary

### Vetted Repository Findings

- `packages/logfire-session-replay/src/transport.ts:70-105` — keepalive chunks are delivered in an awaited loop; only the first request starts while its response is pending. — **PRP impact**: lifecycle preparation and request start must be separated from response settlement.
- `packages/logfire-session-replay/src/transport.ts:153-184` — `keepalive` controls both `RequestInit.keepalive` and retry count; a compressed lifecycle body over 60,000 bytes becomes a normal three-attempt request. — **PRP impact**: carry lifecycle intent separately and assert one attempt for all lifecycle chunks.
- `packages/logfire-session-replay/src/transport.ts:278-318` — chunking estimates pre-compression JSON with `.length`, and ordinary gzip has no fallback. — **PRP impact**: use UTF-8 estimates for buffer/chunk decisions and actual compressed bytes for aggregate keepalive admission; retain the encoded input for fallback.
- `packages/logfire-session-replay/src/transport.ts:171-201` — every status below 500 is classified nonretryable and `ReplayIngestError` keeps only the status. — **PRP impact**: preserve response retry metadata, classify only 429 as transient among 4xx, and keep credentials resolved per actual attempt.
- `packages/logfire-session-replay/src/capture.ts:470-486` — string request bodies use UTF-16 `.length`; buffers/views/blobs already use byte sizes. — **PRP impact**: change only the string branch to UTF-8 bytes and preserve unsupported-body behavior.
- `packages/logfire-session-replay/src/capture.test.ts:114-139,282-313` — fetch and XHR coverage is ASCII-only. — **PRP impact**: add exact non-ASCII assertions to both shared-helper consumers while preserving the existing R1 wrapper metadata tests.
- `packages/logfire-session-replay/src/index.ts:229-251` — public `visibilitychange`/`pagehide` listeners initiate lifecycle flushes; no new public API is needed. — **PRP impact**: the built-package navigation fixture can exercise the real entry point.
- `packages/logfire-session-replay/README.md:125-137` — the standalone guide already warns that asynchronous credentials can miss page freeze; `packages/logfire-browser/README.md:207-275` and `docs/packages/browser.md:202-267` show async headers without the warning. — **PRP impact**: R3 owns implementation and browser-facing propagation of this caveat; R6 only preserves/reviews it.
- `packages/logfire-browser/test-fixtures/self-observation/vite.config.ts:17-45` — an existing fixture loads built replay output and rewrites rrweb/fflate to their browser ESM entrypoints. — **PRP impact**: reuse this exact package-loading pattern instead of importing source.
- `packages/logfire-browser/test-fixtures/provider-lifecycle/` — scenario-keyed loopback receipts plus `agent-browser` form the repository's current direct-browser pattern. — **PRP impact**: use the same visible state, server receipt, and exact verifier approach on port 4177.
- `.changeset/stable-browser-rum-lifecycle.md` and `.changeset/session-replay-package.md` already plan the stable replay package; R2 added a focused patch changeset without altering final version math. — **PRP impact**: add one focused replay patch changeset and leave final reconciliation to R8.

### External Constraints

- `WHATWG Fetch`, current Living Standard — unfinished known-length keepalive bodies in the client's fetch group are summed; a new request becomes a network error when the aggregate exceeds 64 KiB. A request's done flag is set at response end-of-body, not merely when response headers make the `fetch()` promise resolve. Only actual body lengths count, and unrelated page traffic is unknowable to the library. — https://fetch.spec.whatwg.org/#http-network-or-cache-fetch and https://fetch.spec.whatwg.org/#main-fetch
- `RFC 9110 §10.2.3` — `Retry-After` is either non-negative decimal delay-seconds or an HTTP-date. — https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3
- `RFC 9110 §5.6.7` — HTTP-date recipients must accept IMF-fixdate plus the RFC 850 and asctime obsolete forms. — https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.7
- `RFC 6585 §4` — 429 means too many requests and may include `Retry-After`. — https://www.rfc-editor.org/rfc/rfc6585.html#section-4
- `fflate 0.8.3` — async methods run in workers; the browser worker source constructs a Blob URL and `new Worker(...)`, while input transfer occurs only with `consume: true`. — https://github.com/101arrowz/fflate/blob/v0.8.3/README.md#L379-L381 and https://github.com/101arrowz/fflate/blob/v0.8.3/src/worker.ts#L1-L19
- `CSP Level 3 worker-src` — the directive governs Worker URLs, so `worker-src 'none'` rejects the Blob worker used by fflate async gzip. — https://www.w3.org/TR/CSP/#directive-worker-src

### Spike Evidence

- `plans/research/roadmaps/001-browser-rum-release-remediation/spike-02-unload-keepalive-policy.md` — **Question**: can all unload chunks start safely before freeze? — **Result/decision**: precompress and start only the bounded aggregate admitted below the 64 KiB shared limit; do not use `sendBeacon()` because it cannot preserve arbitrary authentication/custom headers and encoding. — **Limits**: the spike modeled scheduling but did not execute real navigation.
- `plans/research/roadmaps/001-browser-rum-release-remediation/spike-03-csp-gzip-fallback.md` — **Question**: can the same batch survive async worker failure? — **Result/decision**: with `consume: false`, the retained input can be synchronously compressed and decoded; recovered fallback is not an error, both-path failure reports once and sends nothing. — **Limits**: the spike did not enforce CSP in a real browser.

### Settled Decisions and Rejected Alternatives

- **Decision**: reserve at most 48,000 bytes of actual compressed keepalive bodies across all unfinished lifecycle requests owned by one transport, not independently per `flush()`. Admission uses `max(0, 48_000 - reservedKeepaliveBytes)` and reserves synchronously before any request start. — **Evidence/rationale**: 48,000 is 73.2% of the normative 65,536-byte shared limit and leaves 17,536 bytes for unrelated unfinished page requests; transport-wide accounting prevents two overlapping lifecycle flushes from self-overcommitting the library budget.
- **Decision**: for each lifecycle flush, admit the earliest contiguous sequence prefix that fits currently unreserved capacity; start every remaining/excess chunk once with `keepalive: false` as best effort. — **Evidence/rationale**: this favors a contiguous replay prefix, preserves the existing oversized-body fallback, retains every preallocated sequence, and never turns lifecycle work into ordinary retries.
- **Decision**: release a body's reservation if credential resolution or fetch setup fails before a request exists, after network rejection, or after the response reaches end-of-body. Because `fetch()` can resolve at headers, explicitly cancel an unread response body and wait for cancellation before release; a null/already-ended body can release immediately. If a started request's end-of-body/cancellation cannot be confirmed, retain the reservation conservatively for the transport lifetime. — **Evidence/rationale**: this mirrors Fetch's done-flag boundary without leaking capacity for pre-request failures or exposing a second flush to quota still counted by the browser.
- **Decision**: launch all lifecycle send promises without awaiting any response between starts, then settle them together through the existing guarded error path. — **Evidence/rationale**: parent `CX-3` requires request starts, not guaranteed post-termination completion; sequence numbers reconstruct order even if responses or arrivals reorder.
- **Decision**: memoize async-compressor unavailability per `ReplayTransport`; later ordinary batches on that transport go directly to `gzipSync`. — **Evidence/rationale**: it removes recurring deterministic failure without introducing global mutable state across independent replay controllers; a new session runtime may probe capability once again.
- **Decision**: accept and honor valid `Retry-After` delays up to 10,000 ms while retaining three total ordinary attempts. Parse digit-only seconds before HTTP-date; a past date yields zero; absent/invalid values use the existing 500 ms × attempt backoff. If valid guidance exceeds 10,000 ms, stop this delivery chain and report the ingest failure instead of retrying earlier than requested. — **Evidence/rationale**: at most two header-directed waits bound one ordinary delivery chain to 20 seconds without violating the server's stated minimum; the choice is internal and reversible.
- **Decision**: validate the exact IMF-fixdate, RFC 850, and asctime grammars before conversion, including RFC 850's more-than-50-years-future two-digit-year rollback, and reject other platform-parseable date strings. — **Evidence/rationale**: those are the RFC 9110 recipient requirements; permissive `Date.parse` alone would accept values such as ISO-8601 that are not valid `Retry-After` HTTP-dates.
- **Decision**: resolve headers/token for each actual retry exactly as today. — **Evidence/rationale**: recovered delivery must not become unauthenticated; R4 owns broader hostile-callback containment.
- **Rejected**: reuse the existing 60,000-byte per-body threshold as the aggregate budget. — **Reason**: it leaves only 5,536 bytes for host traffic and is not meaningfully conservative for a shared page-level quota.
- **Rejected**: `navigator.sendBeacon()`. — **Reason**: it cannot preserve the current arbitrary headers, authorization, and gzip content-encoding contract.
- **Rejected**: unconstrained `Promise.all`, serial response waiting, or a chunk-count limit. — **Reason**: each violates either the aggregate byte constraint or the before-freeze start requirement.
- **Rejected**: retry an over-budget lifecycle body because its fetch is not keepalive. — **Reason**: lifecycle intent, not the request flag, owns the one-attempt invariant.
- **Rejected**: report the recovered worker failure through `onError`. — **Reason**: successful synchronous fallback is expected degradation and no replay data was lost.
- **Rejected**: expose keepalive/retry policy as new public configuration. — **Reason**: the constants are implementation safety bounds and can be revised before promising API surface.

### Validation Baseline

| Command                                             | Status                                                    | Observed or expected result                         |
| --------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------- |
| `vp run @pydantic/logfire-session-replay#test`      | Verified on 2026-07-13                                    | 8 files, 100 tests passed                           |
| `vp run @pydantic/logfire-session-replay#typecheck` | Verified on 2026-07-13                                    | `tsc` passed                                        |
| `vp run @pydantic/logfire-session-replay#build`     | Verified on 2026-07-13                                    | CJS/ESM packages and declarations built             |
| Existing keepalive first-response gate              | Baseline failing by inspection/spike                      | Only sequence 0 starts before its response resolves |
| Real-browser navigation/CSP/retry/UTF-8 fixture     | Discovered but not run                                    | Required by this PRP                                |
| `pnpm run check`                                    | Verified for the protected R1/R2 baseline before this PRP | Required again after implementation                 |

### Research Coverage

- **Depth**: Deep
- **Inspected**: replay transport/capture/public lifecycle source and tests; standalone and integrated docs; current built-package browser fixtures; installed fflate browser implementation; Fetch/CSP/HTTP primary standards; parent roadmap and both prerequisite spikes; current dirty R1/R2 baseline.
- **Not inspected**: Platform ingest/playback internals, R4 backpressure/host-containment work, R5 privacy decisions, R7 proxy/examples, R8 release simulation, Safari/Firefox engine deviations, and unrelated application keepalive traffic because they are outside this child.
- **Research confidence**: HIGH — all architectural choices are source-, spike-, or standards-backed; only fixture payload calibration and runner-specific lifecycle timing remain execution work.

## Execution Contract

- **Planned at commit**: `f57d9ec`
- **Planning baseline**: preserve all current R1/R2 and user planning/report work. The exact pre-PRP `git status --short` snapshot was:

  ```text
   M docs/packages/browser.md
   M packages/logfire-browser/README.md
   M packages/logfire-browser/package.json
   M packages/logfire-browser/src/index.test.ts
   M packages/logfire-browser/src/index.ts
   M packages/logfire-browser/src/sessionReplay.test.ts
   M packages/logfire-browser/src/sessionReplay.ts
   M packages/logfire-session-replay/README.md
   M packages/logfire-session-replay/src/capture.test.ts
   M packages/logfire-session-replay/src/capture.ts
   M packages/logfire-session-replay/src/index.test.ts
   M packages/logfire-session-replay/src/index.ts
   M pnpm-lock.yaml
  ?? .changeset/browser-provider-reconfiguration.md
  ?? packages/logfire-browser/src/browserConfigure.integration.test.ts
  ?? packages/logfire-browser/src/providerLifecycle.integration.test.ts
  ?? packages/logfire-browser/src/providerLifecycle.test.ts
  ?? packages/logfire-browser/src/providerLifecycle.ts
  ?? packages/logfire-browser/src/selfObservation.integration.test.ts
  ?? packages/logfire-browser/src/telemetryUrls.test.ts
  ?? packages/logfire-browser/src/telemetryUrls.ts
  ?? packages/logfire-browser/test-fixtures/
  ?? plans/020-browser-rum-replay-lifecycle.md
  ?? plans/023-browser-telemetry-self-observation.md
  ?? plans/024-browser-provider-reconfiguration.md
  ?? plans/research/
  ?? plans/roadmaps/
  ?? reports/pr-161-combined-review.md
  ?? reports/pr-161-review.md
  ```

  Integrate rather than overwrite every overlapping path. `packages/logfire-session-replay/src/transport.ts` and `transport.test.ts` were untouched at planning time; `plans/025-replay-delivery-reliability.md` is the artifact added after this snapshot.

### Expected Changes

- `packages/logfire-session-replay/src/transport.ts` — UTF-8 estimates, retained-input compression fallback, lifecycle preparation/admission/start scheduling, distinct lifecycle/request flags, and bounded 429 retry parsing.
- `packages/logfire-session-replay/src/transport.test.ts` — exact quota/start/sequence/one-attempt, compression-fallback, and fake-clock retry matrices.
- `packages/logfire-session-replay/src/capture.ts` — UTF-8 size for string bodies only.
- `packages/logfire-session-replay/src/capture.test.ts` — exact fetch and XHR multibyte body assertions while preserving R1 wrapper tests and the settled `vite-plus/test` import.
- `packages/logfire-session-replay/README.md` — aggregate best-effort lifecycle and CSP degradation wording while retaining standalone `flush()` advice.
- `packages/logfire-browser/README.md` and `docs/packages/browser.md` — integrated async credential/page-freeze, shared quota, and CSP fallback guidance without suggesting an inaccessible replay handle.
- `packages/logfire-session-replay/test-fixtures/delivery/` — built-package real-browser pages, delayed/scripted proxy, state, and verifier.
- `.changeset/replay-delivery-reliability.md` — replay patch note without altering intended stable version math.
- `plans/roadmaps/001-browser-rum-release-remediation.md` — execution/verification status only; R3 owns the credential caveat and R6 preserves it.

### Explicitly Out of Scope

- Guaranteeing delivery after browser termination or accounting for unrelated host keepalive bodies.
- Changing the replay envelope, URL shape, sequence semantics, authentication model, public option types, or direct-token posture.
- Retaining/requeueing failed batches beyond the existing attempt contract, persistence across reload, or introducing an offline queue/service worker.
- R4's buffer-mode cap, activity persistence debounce, callback containment, error reentrancy, and storage-failure work.
- R5 privacy defaults and navigation/text/console redaction choices.
- R6 Web Vitals span type, metrics degradation, replay handle placement, session-inactivity documentation, and other optional-feature API decisions.
- R7 proxy/example server behavior and R8 final Changesets reconciliation.
- Inspecting or modifying `../platform`.

### Scope Expansion Rule

Additional files may be changed when necessary to satisfy the PRP without changing its intent or architecture. Record each added file and rationale in Execution Notes. Pause for user direction if expansion introduces a public configuration option, changes wire/authentication semantics, adds persistent delivery, changes privacy behavior, or requires rewriting protected R1/R2 work.

### Pause and Reassess If

- The available real browser cannot load built rrweb/fflate under the stated CSP or cannot expose direct evidence that multiple navigation-triggered requests arrived before any held response was released.
- Correct scheduling still cannot produce two admitted lifecycle requests under a calibrated 48,000-byte compressed aggregate without changing the wire envelope or public recorder API.
- fflate 0.8.3 consumes/detaches the input despite `consume: false`, or synchronous fallback cannot reproduce the original envelope.
- Supporting the RFC-required HTTP-date forms needs a new production dependency rather than a small local parser/validated platform primitive.
- The change would overwrite or semantically reverse R1 self-observation or R2 lifecycle behavior in an overlapping file.

## Context

### Key Files

- `packages/logfire-session-replay/src/transport.ts` — core buffer, compression, sequence, retry, and lifecycle delivery implementation.
- `packages/logfire-session-replay/src/transport.test.ts` — focused deterministic transport boundary and current immediately-resolving large-chunk test that masks response serialization.
- `packages/logfire-session-replay/src/capture.ts` — shared fetch/XHR body sizing.
- `packages/logfire-session-replay/src/capture.test.ts` — network payload assertions plus protected R1 wrapper metadata coverage.
- `packages/logfire-session-replay/src/index.ts` — public handle and genuine `visibilitychange`/`pagehide` listeners.
- `packages/logfire-session-replay/src/types.ts` — versioned envelope and public network payload; no type-shape change expected.
- `packages/logfire-session-replay/README.md` — existing lifecycle and credential caveat to extend.
- `packages/logfire-browser/README.md` and `docs/packages/browser.md` — integrated examples that currently omit the caveat.
- `packages/logfire-browser/test-fixtures/self-observation/` — built replay virtual-module/loading pattern.
- `packages/logfire-browser/test-fixtures/provider-lifecycle/` — current scenario-keyed Vite receipt/verifier and agent-browser pattern.

### External References

- https://fetch.spec.whatwg.org/#http-network-or-cache-fetch — shared unfinished keepalive-body accounting.
- https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3 — `Retry-After` grammar.
- https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.7 — required HTTP-date forms.
- https://www.rfc-editor.org/rfc/rfc6585.html#section-4 — 429 semantics.
- https://github.com/101arrowz/fflate/blob/v0.8.3/src/worker.ts#L1-L19 — Blob-backed browser worker.
- https://github.com/101arrowz/fflate/blob/v0.8.3/src/index.ts#L1745-L1767 — async gzip path.
- https://www.w3.org/TR/CSP/#directive-worker-src — worker policy enforcement.

### Gotchas

- The Fetch limit is shared by unfinished keepalive bodies in the client fetch group; a library constant cannot discover remaining quota or guarantee acceptance.
- Aggregate admission must use the final compressed `Uint8Array.byteLength`, while `maxBufferBytes` and pre-compression chunking must use UTF-8 JSON bytes. Do not substitute one measure for the other.
- The 48,000-byte budget is transport-wide reserved capacity, not a fresh allowance per `flush()`. Reserve synchronously before starting admitted sends; release immediately when no request was created, or after network rejection/confirmed response end-of-body for a started request. A resolved `fetch()` promise with an unread streaming body is not sufficient.
- Genuine lifecycle delivery must not await credential resolution or a prior response serially between chunks. Starting all send promises concurrently initiates async functional credentials concurrently, but slow credentials can still miss freeze and must stay documented.
- Sequence allocation occurs before concurrent sends. Arrival order can change; completeness/order assertions must reconstruct by `seq`, not receipt timestamp.
- Lifecycle intent remains true even when `RequestInit.keepalive` is false. Retry eligibility must never be derived from the latter again.
- fflate can fail synchronously while constructing its worker or asynchronously through its callback. The helper must catch both and retain bytes by leaving `consume` false.
- Successful fallback must not call `onError`; double compression failure calls it once and performs no fetch.
- `Retry-After` delay-seconds is digit-only and non-negative. Invalid, signed, fractional, or overflowing values fall back to ordinary backoff; valid past dates use zero; valid delays above 10 seconds stop the delivery chain rather than being clamped downward.
- Validate HTTP-date grammar before conversion rather than handing arbitrary strings to `Date.parse`. Cover IMF-fixdate, RFC 850, asctime, invalid calendar values, ISO-8601 rejection, and RFC 850's two-digit-year rollback relative to the injected/fake current time.
- Every retry must re-resolve configured credentials. Do not fall back to empty headers if the resolver fails.
- The integrated browser API does not expose standalone `replay.flush()`; only the standalone guide may recommend calling it before controlled navigation.
- `capture.test.ts` currently imports the supported `vite-plus/test` entrypoint and passes the baseline. The roadmap dispositions that cleanup item as no change; preserve the import and do not assign it to another child.

## Implementation Blueprint

### Data Models

- **Prepared replay upload**: immutable `{ seq, sessionId, body: Uint8Array, lifecycle, requestKeepalive }`; `lifecycle` owns attempts, `requestKeepalive` owns only the Fetch flag.
- **Keepalive reservation ledger**: transport-local `reservedKeepaliveBytes`; admitted bodies reserve their exact compressed byte length synchronously and release only at the Fetch done-equivalent boundary.
- **Compression capability**: transport-local state initially allowing async gzip, switched permanently to sync-only after any async setup/callback failure.
- **Replay ingest error**: status plus optional parsed retry delay derived from the response's `Retry-After` header; no header/token values are retained or reported.

### Tasks

```yaml
Task 1: Make replay and captured request estimates byte-accurate
  MODIFY packages/logfire-session-replay/src/transport.ts:
    - Encode JSON once with fflate strToU8 (or one equivalent UTF-8 helper) and use byteLength for event estimates that drive maxBufferBytes and pre-compression chunking.
    - Preserve zero-on-serialization-failure behavior and do not fold aggregate compressed admission into this estimate.
  MODIFY packages/logfire-session-replay/src/capture.ts:
    - Count string BodyInit values with TextEncoder UTF-8 bytes.
    - Preserve exact ArrayBuffer/view/Blob sizes, 0 for null/undefined or no init.body, and undefined for unsupported non-null BodyInit values. Request-input bodies remain uninspected and therefore continue to report 0.
  MODIFY packages/logfire-session-replay/src/capture.test.ts:
    - Add exact native fetch and XHR cases for "é🚀" => reqBytes 6.
    - Characterize fetch(new Request(...with a body...)) as the existing reqBytes 0 unless a later public-contract decision explicitly adds Request-body inspection.
    - Preserve all R1 __original wrapper assertions and the roadmap's settled no-change `vite-plus/test` import.
  MODIFY packages/logfire-session-replay/src/transport.test.ts:
    - Characterize multibyte event estimates crossing maxBufferBytes/chunk thresholds by transmitted UTF-8 size rather than code-unit length.
  ENABLES: CX-4 and correct CX-1 admission inputs.
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-session-replay#test -- -t "bytes|network|buffer"
    - EXPECTED: Exact fetch, XHR, and replay threshold assertions pass; "é🚀" is 6 bytes.

Task 2: Recover ordinary compression without losing a detached batch
  MODIFY packages/logfire-session-replay/src/transport.ts:
    - Convert the serialized envelope to retained UTF-8 bytes once.
    - While the transport's async compressor is available, catch both gzip setup throws and callback errors; mark it unavailable and run gzipSync over the same retained input.
    - Route subsequent ordinary batches on that transport directly to gzipSync.
    - Keep lifecycle compression synchronous and keep fflate consume disabled.
    - Let successful fallback continue to send without reporting; let double failure reach the existing guarded report exactly once and send nothing.
  MODIFY packages/logfire-session-replay/src/transport.test.ts:
    - Force setup throw and callback error separately; gunzip and compare exact original envelope/events.
    - Send a later ordinary batch and prove async compression is not attempted again.
    - Force both paths to fail and assert one onError call, zero fetches, and no public rejection escape.
  PATTERN: plans/research/roadmaps/001-browser-rum-release-remediation/spike-03-csp-gzip-fallback.md
  ENABLES: CX-2.
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-session-replay#test -- -t "gzip|compression|CSP"
    - EXPECTED: Setup/callback fallback, memoization, valid bytes, and double-failure containment pass.

Task 3: Schedule bounded lifecycle uploads before response waiting
  MODIFY packages/logfire-session-replay/src/transport.ts:
    - Allocate contiguous sequence numbers and construct version-1 envelopes exactly as today.
    - Maintain transport-local reservedKeepaliveBytes across overlapping lifecycle flushes.
    - Prepare lifecycle chunks as gzip bodies, atomically reserve and admit the earliest contiguous prefix whose aggregate byteLength fits max(0, 48_000 - reservedKeepaliveBytes), and mark remaining chunks requestKeepalive false.
    - Start every prepared lifecycle send promise without awaiting any response between starts; settle/report them together while preserving ordinary flush serialization and lifecycle bypass of an ordinary response already in flight.
    - Carry lifecycle intent independently so all prepared lifecycle chunks have one attempt, including normal-fetch excess bodies.
    - Release each admitted reservation immediately if credential resolution/fetch setup fails before a request exists, after network rejection, or after confirmed response end-of-body. Explicitly cancel and await an unread response body before release; do not release at headers-only fetch resolution, and retain the reservation conservatively if a started request's completion cannot be confirmed.
    - Preserve headers/token resolution, body slicing, Content-Type/Content-Encoding, URL escaping, stored seq, and guarded errors.
  MODIFY packages/logfire-session-replay/src/transport.test.ts:
    - Hold sequence 0's response open and prove at least two admitted requests start first, each with keepalive true, contiguous URLs, valid gzip, and aggregate body bytes <= 48_000.
    - Assert the exact budget boundary: fitting bodies are admitted and the next body is one normal-fetch best-effort attempt.
    - Start a second lifecycle flush while the first flush's responses remain unfinished and prove total keepalive:true reservations across both flushes stay <= 48_000; after confirmed end-of-body, prove a later flush reclaims capacity.
    - Resolve fetch at headers while holding response-body cancellation/end open and prove the reservation remains charged; cover credential/setup failure, network rejection, end-of-body, and cancellation failure so pre-request capacity is reclaimed, confirmed completion releases, and unknown completion remains reserved.
    - Force that excess attempt to fail/return 429 and assert no retry, one final report, and retained seq.
    - Preserve ordinary-vs-lifecycle in-flight concurrency and add a sequence-arrival reordering assertion.
  PATTERN: plans/research/roadmaps/001-browser-rum-release-remediation/spike-02-unload-keepalive-policy.md
  ENABLES: CX-1.
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-session-replay#test -- -t "keepalive|lifecycle|sequence"
    - EXPECTED: All admitted requests start before response zero, overlapping flushes never reserve more than 48,000 bytes, completion reclaims capacity at the correct boundary, and every lifecycle chunk has one attempt.

Task 4: Add bounded ordinary 429 and Retry-After handling
  MODIFY packages/logfire-session-replay/src/transport.ts:
    - Preserve status and raw response timing input long enough to classify 429 separately from other 4xx.
    - Parse digit-only seconds first, then grammar-validate and convert IMF-fixdate, RFC850, or asctime HTTP-date values; implement RFC850's >50-year future rollback and reject permissively parseable non-HTTP formats. Invalid/missing values use SEND_BACKOFF_MS * attempt.
    - Honor valid delays through 10_000 ms, map past dates to zero, and stop without another attempt when valid guidance exceeds 10_000 ms; retain MAX_SEND_ATTEMPTS = 3.
    - Apply the policy only to ordinary delivery; lifecycle delivery never sleeps or retries.
    - Re-resolve headers/token on every actual attempt; never send an authenticated retry without requested credentials.
  MODIFY packages/logfire-session-replay/src/transport.test.ts:
    - With fake timers/system time, cover 429->202, seconds, IMF-fixdate, RFC850 plus >50-year rollover, asctime, past date, invalid calendar/ISO-8601/malformed/signed/fractional/overflow input, an over-10-second valid delay that performs no early retry, fallback 500/1000ms, exhausted attempts, 404 no retry, and lifecycle 429 one attempt/no timer.
    - Assert retries keep the same seq/body and invoke functional credentials for each attempted fetch.
  ENABLES: CX-3.
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-session-replay#test -- -t "429|Retry-After|retries"
    - EXPECTED: The full status/parser/cap/credential matrix passes without real wall-clock waits.

Task 5: Build direct real-browser replay delivery acceptance
  CREATE packages/logfire-session-replay/test-fixtures/delivery/index.html and after-unload.html:
    - Provide a visible scenario/status shell and inert same-origin navigation target.
  CREATE packages/logfire-session-replay/test-fixtures/delivery/main.ts:
    - Select unload, csp, retry-after, or utf8 from pathname and expose window.__logfireReplayDelivery phase/error/evidence state.
    - Import only the built public replay package via the fixture virtual module; use fixed session IDs, synchronous marker auth, long automatic flush intervals, and scenario-specific capture settings.
    - For unload, create two distinct approximately 25 KiB deterministic pseudo-random DOM text mutations with separate markers. Separate them with a macrotask/animation frame and wait another frame before navigation so rrweb's MutationObserver records two individual events rather than coalescing one >48 KiB event that cannot be split. Calibrate the resulting two chunks so their compressed aggregate remains comfortably below 48,000; arm a normal anchor and let genuine navigation produce pagehide.
    - For CSP, require Worker availability and captureConsole, emit a distinct deterministic console marker before each of two ordinary flushes (including a fresh marker after flush one drained its batch), observe worker-src policy violations, and record zero recovered-fallback errors.
    - For retry, perform one public ordinary flush against a scripted 429 Retry-After: 1 then 202 response.
    - For UTF-8, send native fetch and XHR bodies "é🚀" to application endpoints before public flush.
  CREATE packages/logfire-session-replay/test-fixtures/delivery/vite.config.ts:
    - Reuse self-observation's built dist/rrweb/fflate browser-entry virtual module pattern and bind 127.0.0.1:4177.
    - Serve an actual CSP header containing worker-src 'none' on /csp/ without blocking same-origin scripts/connect.
    - Store scenario-keyed replay/application receipts, headers, body bytes, receive/response-release times, CSP-facing state, and retry attempts.
    - Hold all unload responses until an explicit release endpoint; script retry attempt one as 429 Retry-After: 1 and attempt two as 202; expose reset/status/release endpoints.
  CREATE packages/logfire-session-replay/test-fixtures/delivery/verify.mjs:
    - Poll, gunzip, and exactly validate each scenario; reconstruct unload order by seq, require at least two authenticated receipts before any response release, and require the two distinct mutation markers in their expected separate sequence chunks.
    - Assert unload compressed keepalive candidate sum <= 48,000; in finally, release held responses so failed verification cannot strand the server.
    - Require two CSP-decoded batches containing their respective distinct console markers, one observed blocked worker attempt, no second attempt, and zero onError; require retry body/seq/auth identity and >=1000ms receipt delta on the same server clock; require server/body and both network events equal 6 UTF-8 bytes.
  PATTERN: packages/logfire-browser/test-fixtures/self-observation and packages/logfire-browser/test-fixtures/provider-lifecycle
  ENABLES: CX-1, CX-2, CX-3, CX-4 and parent CX-3.
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-session-replay#build
    - EXPECTED: Built public artifacts exist for the fixture.
    - COMMAND: vp dev --config packages/logfire-session-replay/test-fixtures/delivery/vite.config.ts --host 127.0.0.1 --port 4177
    - EXPECTED: Loopback fixture starts; run the exact Consumer Verification Plan in a second terminal.

Task 6: Publish the bounded delivery contract in docs and release metadata
  MODIFY packages/logfire-session-replay/README.md:
    - Explain the transport-wide aggregate compressed keepalive prefix across unfinished requests, shared browser quota/non-guarantee, one-attempt excess fallback, and ordinary CSP sync degradation.
    - Retain the standalone advice to call public flush() before controlled navigation and prefer synchronously available proxy credentials.
  MODIFY packages/logfire-browser/README.md:
    - Add the same best-effort/shared-quota/CSP behavior and async functional credential warning near the existing replay example.
    - Do not tell integrated users to call a replay handle the browser API does not expose.
  MODIFY docs/packages/browser.md:
    - Mirror the supported integrated guidance exactly.
  CREATE .changeset/replay-delivery-reliability.md:
    - Add a patch changeset for @pydantic/logfire-session-replay describing bounded lifecycle starts, CSP-safe compression, 429 retry guidance, and exact byte accounting.
  MODIFY plans/roadmaps/001-browser-rum-release-remediation.md:
    - During execution, record R3 evidence/status and retain R6's role as preservation/review rather than ownership of the credential caveat.
  ENABLES: CX-5, R6, R8, and R9.
  VERIFY:
    - COMMAND: vp fmt --check packages/logfire-session-replay/README.md packages/logfire-browser/README.md docs/packages/browser.md .changeset/replay-delivery-reliability.md
    - EXPECTED: All three guides and the focused changeset are formatted and consistent.

Task 7: Run integrated gates and record evidence
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-session-replay#test
    - EXPECTED: Every replay test passes with the new exact count recorded in Execution Progress.
    - COMMAND: vp run @pydantic/logfire-session-replay#typecheck
    - EXPECTED: TypeScript passes without public type expansion.
    - COMMAND: vp run @pydantic/logfire-session-replay#build
    - EXPECTED: ESM/CJS/declarations build.
    - COMMAND: vp run @pydantic/logfire-browser#test && vp run @pydantic/logfire-browser#typecheck && vp run @pydantic/logfire-browser#build
    - EXPECTED: Protected R1/R2 browser behavior remains green.
    - COMMAND: node_modules/.bin/changeset status --verbose
    - EXPECTED: Browser remains planned for 0.17.0 and replay for 0.1.0; the known private Next.js artifact remains solely R8-owned.
    - COMMAND: pnpm run check
    - EXPECTED: Repository build, format/lint/check, typecheck, and all package tests pass.
```

### Integration Points

```yaml
PUBLIC_API:
  - packages/logfire-session-replay/src/index.ts — existing public lifecycle listeners and handle consume the improved transport without a signature change.
  - packages/logfire-browser/src/sessionReplay.ts — existing option forwarding inherits replay delivery behavior; no integrated flush handle is added.

WIRE:
  - packages/logfire-session-replay/src/transport.ts — preserve gzip Content-Encoding, JSON Content-Type, Authorization/custom headers, encoded session ID, ?seq=, and envelope version 1.

FIXTURE:
  - packages/logfire-session-replay/test-fixtures/delivery/vite.config.ts — loopback-only delayed/scripted proxy and actual CSP header on port 4177.

RELEASE:
  - .changeset/replay-delivery-reliability.md — focused replay patch folded into the already planned 0.1.0 stable exit by R8.
```

## Validation

```bash
vp run @pydantic/logfire-session-replay#test
vp run @pydantic/logfire-session-replay#typecheck
vp run @pydantic/logfire-session-replay#build
vp run @pydantic/logfire-browser#test
vp run @pydantic/logfire-browser#typecheck
vp run @pydantic/logfire-browser#build
vp fmt --check packages/logfire-session-replay/src packages/logfire-session-replay/test-fixtures/delivery packages/logfire-session-replay/README.md packages/logfire-browser/README.md docs/packages/browser.md .changeset/replay-delivery-reliability.md plans/025-replay-delivery-reliability.md
node_modules/.bin/changeset status --verbose
pnpm run check
```

The executor must also run all four exact Vite/agent-browser/receipt scenarios below. Package tests do not satisfy parent `CX-3`. If actual navigation or restrictive-CSP evidence is unavailable, R3 remains unverified.

### Required Test Coverage

- [ ] UTF-8 event estimates and fetch/XHR `"é🚀"` request bodies equal 6 bytes.
- [ ] First-response-held lifecycle scheduling, exact transport-wide 48,000-byte aggregate boundary across overlapping flushes, headers-vs-end-of-body reservation timing, capacity reclamation, contiguous sequences, excess normal-fetch one-attempt behavior, and ordinary-in-flight coexistence.
- [ ] Async gzip setup throw, callback error, valid same-input sync fallback, per-transport memoization, and double-failure one-report/zero-fetch containment.
- [ ] Ordinary 429 seconds/date parsing, all HTTP-date forms, past/invalid/overflow values, over-10-second no-early-retry behavior, existing fallback backoff, exhaustion, credential re-resolution, and lifecycle no-retry.
- [ ] Built public package under genuine navigation and actual `worker-src 'none'`, with decoded gzip receipts and held-response timing.
- [ ] Protected R1 wrapper metadata/self-observation and R2 browser lifecycle suites remain green.
- [ ] Documentation distinguishes standalone and integrated handle capabilities and contains no delivery guarantee.

### Consumer Verification Plan

Start the fixture once in one terminal:

```bash
vp run @pydantic/logfire-session-replay#build
vp dev --config packages/logfire-session-replay/test-fixtures/delivery/vite.config.ts --host 127.0.0.1 --port 4177
```

Then exercise each scenario in another terminal, resetting the agent browser/session if the fixture verifier requires isolation:

```bash
# CX-1: genuine navigation and delayed responses
agent-browser open http://127.0.0.1:4177/unload/
agent-browser wait --fn "window.__logfireReplayDelivery?.phase === 'ready'"
agent-browser click "#leave"
agent-browser wait --fn "location.pathname === '/after-unload.html'"
node packages/logfire-session-replay/test-fixtures/delivery/verify.mjs unload

# CX-2: restrictive CSP and memoized fallback
agent-browser open http://127.0.0.1:4177/csp/
agent-browser wait --fn "window.__logfireReplayDelivery?.phase === 'complete'"
node packages/logfire-session-replay/test-fixtures/delivery/verify.mjs csp

# CX-3: ordinary 429 recovery
agent-browser open http://127.0.0.1:4177/retry-after/
agent-browser wait --fn "window.__logfireReplayDelivery?.phase === 'complete'"
node packages/logfire-session-replay/test-fixtures/delivery/verify.mjs retry-after

# CX-4: native fetch/XHR UTF-8 accounting
agent-browser open http://127.0.0.1:4177/utf8/
agent-browser wait --fn "window.__logfireReplayDelivery?.phase === 'complete'"
node packages/logfire-session-replay/test-fixtures/delivery/verify.mjs utf8
```

| Scenario | Exercise                                                                                                | Expected observable evidence                                                                                                                                                                                  | Environment and prerequisites                                                 |
| -------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `CX-1`   | Built replay, two frame-separated high-entropy rrweb mutations, anchor navigation, held proxy responses | At least two contiguous authenticated gzip sequences received before any held response release; each expected mutation marker is in its own decoded sequence chunk; exact event union; candidate sum <=48,000 | Node 24.14.1, pnpm 11.5.2, Vite+ loopback 4177, agent-browser, no credentials |
| `CX-2`   | Two public ordinary flushes under actual `worker-src 'none'`                                            | Two exact decoded batches, one blocked worker attempt/violation, no second attempt, zero onError                                                                                                              | Same, with Worker support and CSP response header                             |
| `CX-3`   | Public flush against 429 `Retry-After: 1` then 202                                                      | Two identical authenticated seq/body attempts separated by >=1000ms on the same server clock; public completion                                                                                               | Same, scripted local endpoint                                                 |
| `CX-4`   | Native fetch and XHR with `"é🚀"`, then public flush                                                    | Application receives 6 bytes twice; decoded fetch/XHR network events each say `reqBytes: 6`                                                                                                                   | Same, captureNetwork enabled                                                  |
| `CX-5`   | Inspect three guides and built declarations                                                             | Best-effort/credential/CSP wording is consistent; integrated guide exposes no nonexistent handle                                                                                                              | Built replay/browser packages                                                 |

## Unknowns & Risks

- The exact high-entropy rrweb mutation volume must be calibrated so two frame-separated individual events become at least two chunks while their compressed aggregate remains comfortably below 48,000 bytes; actual rrweb output remains execution evidence.
- Browser bfcache/navigation timing can vary. The acceptance claim is only that the proxy received admitted request starts before held response release, not that a killed process guarantees completion.
- A host page may already have consumed some or all of the shared Fetch quota; documentation and tests must not turn 48,000 into a guarantee.
- A custom fetch implementation whose response body cannot be cancelled or observed to end can conservatively retain reservation capacity for the transport lifetime. This degrades later lifecycle requests to one-shot normal fetch rather than risking self-overcommit.
- Synchronous gzip under restrictive CSP can consume main-thread time. This is an accepted bounded degradation for batches that otherwise drop; no performance claim is made here.
- A valid `Retry-After` above 10 seconds ends the current in-memory delivery chain, so that batch is not retried even if the server would accept it later. This preserves bounded runtime and server backpressure at the cost of delivery; do not silently reintroduce an early clamp or persistence queue.

**Confidence: 9/10** for one-pass implementation success. The runtime algorithms and standards constraints are settled; the main remaining execution risk is calibrating and observing the genuine-navigation fixture reliably.

## Execution Notes

### Scope Expansions

- None yet.

### Execution Progress

- Execution started on 2026-07-13 at `f57d9ec`. Preflight confirmed the protected R1/R2 dirty baseline still matched the recorded snapshot; the R3 implementation was integrated into the existing dirty tree without rewriting unrelated R1/R2 work.
- Implemented UTF-8 replay estimates and captured request-body sizing, retained-input async-to-sync gzip fallback with per-transport memoization, transport-wide 48,000-byte lifecycle reservations, one-attempt lifecycle excess delivery, RFC-valid bounded `Retry-After` handling, browser-facing delivery documentation, and the built-package delivery fixture.
- Focused replay verification passed: `vp run @pydantic/logfire-session-replay#test` (8 files, 128 tests), typecheck, build, formatting, and root `vp check` (405 files; no lint/type errors). Browser protection passed: browser tests (11 files, 136 tests), typecheck, build, and `pnpm run check` (all package build/typecheck/test gates).
- Direct browser receipts passed on 2026-07-13 using the built package and Vite loopback fixture: unload received two authenticated contiguous chunks before release (20,915 + 20,419 compressed bytes = 41,334 <= 48,000) with both markers in sequence order; restrictive CSP recorded one `worker-src` violation, two decoded batches, no fallback error; 429 recovery recorded identical seq/body/authenticated attempts 1,002 ms apart; UTF-8 recorded both application bodies and both replay `reqBytes` as 6.

### Deviations

- The fixture's replay-path scenario matcher was corrected to accept both `/replay/<scenario>` and a trailing slash; this was necessary for receipts to reach the scenario proxy and does not alter the public wire contract.
- Fixture-only lint/type suppressions and a local module declaration were added following the repository's existing browser-fixture conventions; no production API or wire-format expansion was needed.

### Independent Verification

- Fresh-context cold preflight review passed on 2026-07-13 after resolving server-respecting over-bound `Retry-After`, transport-wide overlapping keepalive reservations and response end-of-body release, exact Request-input byte compatibility, deterministic two-event unload/CSP fixture requirements, current dirty-baseline protection, and R3/R6/R8 ownership.

### Unresolved Risks

- Delivery remains best-effort under browser termination and shared page keepalive traffic, as documented. The direct navigation gate verifies request starts before held responses are released, not guaranteed post-termination completion.

## Verification Record

### Consumer Acceptance

| Scenario | Grade    | Evidence                                                                                                                                                                                    | Limitations                                                           |
| -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `CX-1`   | VERIFIED | Built-package genuine navigation received two ordered authenticated chunks before held-response release; 20,915 + 20,419 = 41,334 compressed bytes                                          | Browser freeze/termination after request start remains best-effort    |
| `CX-2`   | VERIFIED | Actual `worker-src 'none'` page recorded one blocked worker attempt, two decoded batches, no second worker attempt, and zero `onError` reports                                              | Synchronous fallback may use main-thread time                         |
| `CX-3`   | VERIFIED | Public 429 fixture produced identical authenticated seq/body attempts separated by 1,002 ms; focused parser/retry matrix also passed                                                        | Valid guidance above 10 s intentionally ends the chain                |
| `CX-4`   | VERIFIED | Native fetch/XHR application receipts were 6 bytes each and decoded replay events reported `reqBytes: 6`                                                                                    | Captures metadata only, not bodies                                    |
| `CX-5`   | VERIFIED | Standalone and integrated guides describe per-upload credentials, async page-freeze risk, shared quota, best-effort delivery, and CSP fallback without exposing an integrated replay handle | Documentation is a published-contract review, not a runtime guarantee |

### Compliance and Engineering Review

- **PRP compliance**: Verified. All seven implementation tasks and the required direct-browser acceptance scenarios are covered; no public API, envelope, authentication, or privacy contract changed.
- **Engineering review**: Passed. Fresh-context preflight review and post-lint review found no remaining implementation blockers; the protected R1/R2 suites remain green.
- **Final validation**: Passed with the focused package gates, root `pnpm run check`, changeset status inspection, and direct unload/CSP/429/UTF-8 fixture receipts recorded above.
