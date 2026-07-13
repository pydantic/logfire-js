# Browser privacy-safe defaults

## Goal

Make the first stable browser RUM and session-replay releases privacy-explicit:
page span URLs omit query strings and fragments by default, replay masks all
rendered text and disables console capture by default, and replay page,
navigation, and network URL metadata omits query strings and fragments unless a
consumer deliberately opts into raw values.

## Why

- Browser URLs commonly carry reset tokens, searches, email addresses, and
  application secrets; the current page-span and replay defaults can export
  those values without an explicit choice.
- Input masking alone does not protect rendered names, balances, messages, or
  other text nodes in an rrweb snapshot.
- The public defaults must be settled before `@pydantic/logfire-browser@0.17.0`
  and `@pydantic/logfire-session-replay@0.1.0` become stable contracts.
- Logfire Platform and examples need one exact attribute and replay contract to
  consume and document.

## Success Criteria

- [x] With `rum.session: true`, the default page attributes are exactly
      `logfire.page.url.full = origin + pathname` and
      `logfire.page.url.path = pathname`; query and fragment values require an
      explicit `urlAttributes` callback.
- [x] Standalone and browser-integrated replay expose `maskAllText`, default it
      to `true`, keep `maskAllInputs: true`, and prove through an actual rrweb
      snapshot and mutation that rendered text and input values are masked.
- [x] Replay defaults `captureConsole` to `false`, keeps network/navigation
      metadata enabled, and strips query/fragment values from rrweb page-meta,
      Logfire navigation, and Logfire fetch/XHR URL fields by default.
- [x] Explicit overrides remain functional: consumers can set
      `maskAllText: false`, `captureConsole: true`, `redactUrlPatterns: []`, or a
      raw `urlAttributes` callback and observe the requested data.
- [x] The browser replay example, both package guides, the sole in-repository
      generated-style browser package doc, focused Changeset, and an in-repo
      Platform handoff amendment describe the same defaults and remaining
      DOM-attribute caveat.

## Assurance

- **Profile**: Deep
- **Rationale**: this child changes privacy/security defaults in two public
  packages, affects a downstream Platform contract, and requires direct
  built-package browser evidence rather than unit-only inference.

## Roadmap Context

- **Parent roadmap**: `plans/roadmaps/001-browser-rum-release-remediation.md`
- **Roadmap step**: `R5` — set and enforce replay/page privacy defaults.
- **Satisfied dependencies**: D1 and D2 were settled by the user on 2026-07-13;
  R1-R4 are verified at commit `7cfa9f7`, so endpoint suppression, lifecycle,
  delivery, and failure-containment behavior are inherited baselines.
- **Inherited decisions and invariants**: retain only explicit
  `logfire.page.url.*` page attributes; keep request-target `url.*` attributes
  distinct; preserve input masking, canvas/font disablement, no request/response
  body capture, configurable replay capture classes, and the replay envelope.
- **Contract produced for later steps**: exact privacy defaults and opt-ins for
  R6 API/docs, R7 example wording, R8 release notes, R9 package acceptance, and
  the Platform follow-up.

## Consumer Contract

### Consumer and Public Boundary

- **Consumer(s)**: browser SDK integrators, standalone replay integrators,
  application users whose pages are recorded, Logfire Platform, and developers
  following the browser replay example.
- **Public or supported boundary**: `logfire.configure({ rum, sessionReplay })`,
  `startSessionReplay(config)`, exported option types, emitted span attributes,
  decoded replay envelopes, package guides, example configuration, and focused
  Changesets.
- **Entry point and prerequisites**: built browser/replay packages, a page with
  RUM session and replay enabled, same-origin trace/replay receipt routes, and a
  browser that can run rrweb.
- **Current observable behavior**: page span `full` includes
  `location.href`; replay leaves ordinary DOM text visible, captures console by
  default, applies URL redaction only to matching fetch/XHR URLs, emits custom
  navigation with raw `window.location.href`, and rrweb emits a raw page-meta
  `href` before each full snapshot.
- **Observable promise**: defaults protect rendered text, input values, console
  arguments, and query/fragment values on the named page/network/navigation URL
  surfaces while preserving useful origin/path, method/status/kind, session,
  and replay data; explicit opt-ins restore raw values.
- **Must remain compatible with**: public option names already used by the
  alpha packages, selective `maskTextSelector` and `blockSelector`, explicit
  capture booleans, custom URL-redaction patterns, raw page-URL callbacks,
  replay playback envelope version 1, R1 endpoint ignores, and R3/R4 runtime
  contracts.
- **Not claimed**: automatic sanitization of arbitrary text encoded in DOM
  attributes, CSS, image/resource URLs, application-defined custom replay
  events, explicit `distinctId`, or custom span attributes. The guides must say
  that `maskAllText` masks text nodes, not attributes, and direct consumers to
  `blockSelector`, safe markup, and custom configuration for those surfaces.

### Acceptance Scenarios

| ID      | Given                                                                                                                                                                    | When                                                                                                                                           | Then                                                                                                                                                                                                                                                                                                           | Exact exercise and prerequisites                                                                                                                                                                                            | Required evidence                                                                                                |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `CX-5a` | A page URL, rendered text, input, console call, fetch/XHR URL, and SPA navigation contain distinct secret markers, and the public browser SDK uses only the new defaults | The page creates a session span, records an initial snapshot and later text mutation, performs network/navigation actions, then flushes replay | The span contains only origin+pathname page values; decoded replay contains masked initial/mutated text and input, no Console event, sanitized rrweb Meta/navigation/network URLs and envelope `meta.urls` with preserved non-sensitive metadata, and none of the named secrets in the claimed-field allowlist | Build both packages; run the loopback `privacy-defaults` Vite fixture on port 4178; open `/default/?page_secret=...#...` with an isolated agent-browser session; poll completion; decode OTLP JSON and gzip replay receipts | DIRECT REQUIRED — directly verifies the privacy-safe half of parent `CX-5` through built packages and real rrweb |
| `CX-5b` | The same fixture explicitly sets `maskAllText: false`, `captureConsole: true`, `redactUrlPatterns: []`, and a raw page `urlAttributes` callback                          | The page repeats the same public actions and flush                                                                                             | The exact visible-text, console, raw page URL, raw network/navigation markers, and raw envelope `meta.urls` appear on their expected surfaces, while input masking remains enabled                                                                                                                             | Open `/opt-in/?page_secret=...#...` in a distinct named agent-browser session and run its exact receipt verifier                                                                                                            | DIRECT REQUIRED — directly verifies the explicit-override half of parent `CX-5`                                  |

## Research Summary

### Vetted Repository Findings

- `packages/logfire-browser/src/browserSession.ts:169-181` returns `url.href`
  and `url.pathname` when no callback is supplied. — **PRP impact**: D1 is a
  local default change, but public configure and span tests must prove it.
- `packages/logfire-browser/src/index.test.ts:838-886` already exercises default,
  sanitized, and disabled page attributes through public `configure()` and a
  real tracer. — **PRP impact**: update this canonical public-boundary matrix
  rather than relying only on manager tests.
- `packages/logfire-session-replay/src/types.ts:178-193` defaults input masking
  on, console/network/navigation capture on, and URL redaction to an empty array
  in `resolveConfig()`. — **PRP impact**: add the semantic text option and exact
  side-channel defaults in the standalone package, then preserve them through
  the browser bridge.
- `packages/logfire-session-replay/src/recorder.ts:20-51` owns the rrweb option
  mapping and currently forwards only `maskAllInputs` plus optional selectors.
  — **PRP impact**: implement `maskAllText` here as an internal universal
  selector mapping; do not expose rrweb-specific behavior as the public API.
- `packages/logfire-session-replay/src/capture.ts:63-105,515-527` applies
  `redactUrlPatterns` to network capture but passes raw `window.location.href`
  to navigation capture. — **PRP impact**: share one sanitizer with navigation
  and cover query/fragment removal under push/replace/pop.
- Installed `rrweb@2.1.0` emits `window.location.href` in each Meta event before
  a full snapshot and serializes URL-bearing DOM attributes independently. —
  **PRP impact**: sanitize Meta `data.href` before Logfire buffers the event;
  explicitly document that arbitrary DOM attributes/CSS are outside this
  child's automatic URL guarantee.
- `packages/logfire-browser/src/sessionReplay.ts:144-239` always assigns
  `redactUrlPatterns: options.redactUrlPatterns ?? []`, which would override a
  safer standalone default when the browser caller omits the option. — **PRP
  impact**: omit optional bridge fields when absent so the peer package owns its
  defaults; test omitted and explicit-empty behavior.
- `examples/browser-rum-replay/src/main.ts:49-58,128-132` opts into console
  capture and logs the editable user identifier. — **PRP impact**: remove the
  identifier from console payloads, make any sensitive opt-in explicit, and
  demonstrate the stable default URL behavior.
- `packages/logfire-browser/test-fixtures/self-observation/` provides the
  canonical built-package virtual replay module, loopback receipts, OTLP/replay
  decoding, and agent-browser pattern. — **PRP impact**: adapt it into an
  isolated privacy fixture instead of importing source or adding production
  dependencies.
- `../platform/plans/2026-07-13-browser-rum-stable-sdk-follow-up.md:27-77`
  currently shows query/fragment values in the target stable page attribute and
  describes Platform's callback as the sanitizer. — **PRP impact**: produce an
  exact in-repo amendment for a separately authorized Platform-repository sync;
  do not make an adjacent-repository write part of this child's execution unit.

### External Constraints

- Installed `rrweb@2.1.0` exposes `maskTextSelector`, `maskAllInputs`, and
  `maskTextFn`, but no `maskAllText` option; its serializer uses
  `matches()`/`closest()` for `maskTextSelector`. The package is pinned by the
  workspace lockfile. — **Constraint**: retain the semantic option in Logfire
  and map it internally to `'*'`; do not require a dependency upgrade.
- Installed rrweb Meta events contain a raw `href`, and rrweb snapshot
  serialization also normalizes DOM `href`/`src` values. — **Constraint**: the
  verifier must inspect exact event surfaces and documentation must avoid an
  absolute claim that all strings/attributes are scrubbed.

### Settled Decisions and Rejected Alternatives

- **Decision**: default browser page `full` to `${url.origin}${url.pathname}`
  and keep `path = url.pathname`. — **Evidence/rationale**: user-settled D1;
  query/fragment capture requires an explicit callback.
- **Decision**: add `maskAllText?: boolean`, default it to `true`, preserve
  `maskAllInputs: true`, and default console capture to `false`. —
  **Evidence/rationale**: user-settled D2 and installed rrweb spike.
- **Decision**: keep network and navigation metadata enabled but use default
  redaction that strips query and fragment from every named URL surface;
  `redactUrlPatterns: []` is the deliberate raw-URL opt-in, while a non-empty
  caller list replaces the universal default. — **Evidence/rationale**:
  preserves method/status/timing/kind utility without passively exporting URL
  secrets.
- **Decision**: sanitize rrweb Meta `href` with the same policy because it is
  the core recorder's page-navigation URL surface. — **Evidence/rationale**:
  otherwise the default fixture would still export the page secret even after
  D1 and B11.
- **Rejected**: expose only `maskTextSelector: '*'` in docs. — **Reason**: it
  leaks an rrweb implementation workaround and gives no stable semantic option
  for opting back into visible text.
- **Rejected**: disable network and navigation capture entirely by default. —
  **Reason**: sanitized metadata remains useful and the user selected the
  retain-metadata posture.
- **Rejected**: claim that `maskAllText` sanitizes DOM attributes or arbitrary
  custom events. — **Reason**: rrweb text masking does not cover attributes;
  such a claim would be false and could break replay resource fidelity.
- **Rejected**: modify the adjacent Platform repository, its queries, or PR
  #25595 in this child. — **Reason**: this repository owns the SDK contract and
  has separate instructions/commit ownership; R5 produces a precise in-repo
  amendment for a later authorized Platform sync.

### Spike Evidence

- `plans/research/027-browser-privacy-defaults/spike-01-rrweb-universal-text-mask.md`
  — **Question**: can installed rrweb implement semantic all-text masking? —
  **Result/decision**: `maskTextSelector: '*'` masked heading, paragraph, and
  input values; expose `maskAllText` publicly and keep the mapping internal. —
  **Limits**: jsdom full snapshot only; `CX-5a` must directly verify real-browser
  snapshot and mutation envelopes.

### Validation Baseline

| Command                                             | Status   | Observed or expected result                                                        |
| --------------------------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| `vp run @pydantic/logfire-session-replay#test`      | Verified | 8 files, 136 tests passed at `7cfa9f7`                                             |
| `vp run @pydantic/logfire-session-replay#typecheck` | Verified | Passed at `7cfa9f7`                                                                |
| `vp run @pydantic/logfire-browser#test`             | Verified | 12 files, 142 tests passed at `7cfa9f7`                                            |
| `vp run @pydantic/logfire-browser#typecheck`        | Verified | Passed at `7cfa9f7`                                                                |
| `pnpm run check`                                    | Verified | Passed while verifying PRP 026 at the same source commit; rerun after R5 execution |

### Research Coverage

- **Depth**: Deep
- **Inspected**: browser session/page attribute flow, public configure tests,
  browser-to-peer replay bridge, replay config resolution, rrweb option mapping
  and installed implementation, console/network/navigation capture, replay
  tests/fixtures, browser/replay docs, example configuration and sensitive
  markers, Changesets, combined review, roadmap, and Platform handoff report.
- **Not inspected**: Platform implementation and open PR #25595 internals beyond
  the existing handoff report; backend scrubbing; unrelated Node/Cloudflare
  packages; remote rrweb guidance because installed source/types and direct
  probe establish the relevant version-specific behavior.
- **Research confidence**: HIGH for the implementation path and evidence
  surface; the Deep-assurance cold re-review returned READY with no remaining
  findings, and direct browser evidence remains an execution requirement.

## Execution Contract

- **Planned at commit**: `7cfa9f7`
- **Planning baseline**: clean working tree; branch is two commits ahead of its
  remote before adding this PRP/roadmap research.

### Expected Changes

- `packages/logfire-browser/src/browserSession.ts` and tests — privacy-safe D1
  default and public callback/disable coverage.
- `packages/logfire-browser/src/sessionReplay.ts` and tests — expose/forward
  `maskAllText`, preserve peer defaults when options are omitted, and prove
  explicit overrides.
- `packages/logfire-browser/src/index.test.ts` — public configure/tracer evidence
  for default, raw opt-in, custom sanitization, and suppression.
- `packages/logfire-session-replay/src/types.ts` — public/resolved semantic text
  option, console default, and universal URL-redaction default.
- `packages/logfire-session-replay/src/recorder.ts` and tests — internal
  `maskAllText` mapping and rrweb Meta URL sanitization at the emitted-event
  boundary.
- `packages/logfire-session-replay/src/privacy.ts` and tests — one repeat-safe
  URL sanitizer shared by rrweb Meta and custom network/navigation capture.
- `packages/logfire-session-replay/src/capture.ts` and tests — apply normalized
  URL redaction to navigation as well as fetch/XHR.
- `packages/logfire-session-replay/src/index.ts` and tests — resolve and wire the
  exact default/override matrix without disturbing lifecycle or containment.
- `packages/logfire-browser/test-fixtures/privacy-defaults/` — built-package
  loopback public consumer and exact default/opt-in receipt verifier.
- `packages/logfire-session-replay/README.md`,
  `packages/logfire-browser/README.md`, and `docs/packages/browser.md` — stable
  defaults, opt-ins, examples, and residual attribute/custom-event caveat.
- `examples/browser-rum-replay/src/main.ts` and its README — remove editable
  identifier console leakage and demonstrate/document deliberate capture.
- `reports/pr-161-platform-privacy-handoff.md` — exact amendment for the stale
  adjacent Platform follow-up report, including target examples and
  defense-in-depth wording; actual Platform-repository mutation is separate.
- `.changeset/browser-replay-privacy-defaults.md` — focused patch notes for both
  public packages; R8 retains ownership of final version reconciliation.
- `plans/roadmaps/001-browser-rum-release-remediation.md` — execution and
  verification status only.

### Explicitly Out of Scope

- Sanitizing arbitrary DOM attributes, CSS/resource URLs, application custom
  replay events, `distinctId`, custom span attributes, or data explicitly
  returned by consumer callbacks.
- Any write in the adjacent Platform repository, including its source, existing
  follow-up report, queries, database state, telemetry, or PR #25595.
- R6 lifecycle-handle/API placement, Web Vitals degradation/span-type decisions,
  R7 proxy behavior, and R8 final version simulation.
- Changing the replay envelope, session sampling, upload authentication,
  delivery, endpoint suppression, or provider lifecycle contracts.

### Scope Expansion Rule

Additional files may be changed when necessary to satisfy this PRP without
changing its intent or architecture. Record each added file and rationale in
Execution Notes. Pause for user direction if expansion changes the settled
privacy defaults, introduces automatic DOM-attribute/CSS sanitization, removes
metadata rather than sanitizing it, alters package placement, or requires an
adjacent-repository write.

### Pause and Reassess If

- Real-browser decoded events contain any named page/network/navigation secret
  on a surface this PRP claims to sanitize.
- `maskTextSelector: '*'` fails to mask either the initial full snapshot or a
  later rrweb mutation under the installed browser build.
- Applying Meta URL redaction requires changing the replay envelope or breaks
  rrweb playback rather than changing only the event's URL value.
- Selective `maskTextSelector`, explicit empty redaction patterns, or explicit
  raw page callbacks cannot coexist with the new defaults.
- The exact Platform handoff cannot be stated without depending on unresolved
  R6 API decisions rather than only the settled R5 attribute/privacy contract.

## Context

### Key Files

- `packages/logfire-browser/src/browserSession.ts` — D1 default owner.
- `packages/logfire-browser/src/BrowserSessionSpanProcessor.ts` — page attribute
  emission boundary that must remain key-compatible.
- `packages/logfire-browser/src/sessionReplay.ts` — public integrated replay
  option and peer-config bridge.
- `packages/logfire-session-replay/src/types.ts` — standalone public defaults.
- `packages/logfire-session-replay/src/recorder.ts` — rrweb option/event boundary.
- `packages/logfire-session-replay/src/privacy.ts` — shared URL-value
  sanitization policy without coupling recorder and host-method capture modules.
- `packages/logfire-session-replay/src/capture.ts` — console/network/navigation
  custom-event boundary and URL sanitizer.
- `packages/logfire-browser/test-fixtures/self-observation/` — canonical
  built-package Vite/receipt/verifier pattern.
- `examples/browser-rum-replay/src/main.ts` — current selective masking,
  side-channel opt-ins, and B13 leak.
- `../platform/plans/2026-07-13-browser-rum-stable-sdk-follow-up.md` — downstream
  attribute contract evidence read during planning; execution writes only the
  in-repo amendment report.

### Gotchas

- `maskAllText` is a Logfire semantic option, not an rrweb option. When true it
  dominates a narrower selector; callers must set it false to use selective
  text masking.
- The browser bridge currently supplies empty defaults to the peer. Omitting a
  property is materially different from forwarding `[]` or `false` after this
  change.
- `RegExp.test()` can mutate `lastIndex` for global/sticky expressions. Any
  shared sanitizer must reset state or use a helper so repeated events remain
  deterministic.
- rrweb Meta and FullSnapshot are separate events. Redacting only Logfire's
  custom navigation event leaves the initial page URL exposed.
- A URL fragment is not sent to the server by fetch but remains visible to
  client-side instrumentation, so fixture assertions must inspect decoded
  events rather than server request URLs alone.
- The default universal redaction list must be newly allocated or treated as
  immutable; do not let caller mutation change future controllers.
- The real-browser verifier must search exact expected event fields rather than
  rejecting every secret-shaped string globally, because the explicit opt-in
  scenario intentionally contains them.

## Implementation Blueprint

### Tasks

```yaml
Task 1: Implement standalone semantic privacy defaults
  MODIFY packages/logfire-session-replay/src/types.ts:
    - Add maskAllText to public and resolved config, default true.
    - Change captureConsole default to false.
    - Define a deterministic default URL-redaction policy that matches every non-empty URL; explicit [] opts into raw URLs.
    - Document that caller patterns replace the default.
  MODIFY packages/logfire-session-replay/src/index.ts:
    - Resolve maskAllText and a fresh/default redaction list.
    - Pass maskAllText to the recorder and the same redaction list to network/navigation capture.
    - Preserve all R3/R4 lifecycle, session, error-containment, and buffer behavior.
  MODIFY packages/logfire-session-replay/src/index.test.ts:
    - Assert exact omitted-option defaults and explicit overrides through public startSessionReplay.
    - Assert console capture is not installed by default and is installed when true.
    - Exercise { maskAllText: false, maskTextSelector: '.secret' } through public startSessionReplay and require the resolved recorder options to preserve selective masking.
  PATTERN: packages/logfire-session-replay/src/types.ts:178-193 and index.test.ts:687-713
  ENABLES: CX-5a, CX-5b
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-session-replay#test -- -t "default|privacy|capture"
    - EXPECTED: Exact resolved default/override wiring passes without changing controller lifecycle.

Task 2: Map all-text masking and sanitize rrweb page metadata
  CREATE packages/logfire-session-replay/src/privacy.ts and privacy.test.ts:
    - Move/generalize URL query+fragment stripping into one internal helper used by recorder and capture.
    - Make RegExp matching repeat-safe for global/sticky expressions and preserve caller pattern objects.
    - Cover absolute, relative, malformed, empty-list, universal, selective, global, and sticky inputs.
  MODIFY packages/logfire-session-replay/src/recorder.ts:
    - Accept maskAllText and normalized URL-redaction patterns.
    - Pass '*' as rrweb maskTextSelector when maskAllText is true; otherwise preserve optional selective selector.
    - Before forwarding each rrweb event, clone only the Meta event/data needed to redact href with the shared helper and leave other event identity/content unchanged.
  MODIFY packages/logfire-session-replay/src/recorder.test.ts:
    - Assert true dominates a narrower selector, false preserves/omits selective selector, and original option objects remain unchanged.
    - Emit Meta/full-snapshot/incremental events through the mocked rrweb callback; assert only matching Meta href is sanitized and unrelated data is exact.
  ENABLES: CX-5a, CX-5b
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-session-replay#test -- -t "mask|Meta|recorder"
    - EXPECTED: Semantic mapping and event-level URL behavior are exact.

Task 3: Apply one URL policy to network and navigation custom events
  MODIFY packages/logfire-session-replay/src/capture.ts:
    - Replace the local network-only sanitizer with the shared privacy helper.
    - Pass redactUrlPatterns into captureNavigation and sanitize push/replace/pop href before safeEmit.
    - Preserve network relative/absolute normalization, ignore patterns, method/status/timing/body-byte fields, safe reporter behavior, and wrapper cleanup.
  MODIFY packages/logfire-session-replay/src/capture.test.ts:
    - Cover default-like universal and selective patterns for fetch, XHR, push, replace, and pop with query+fragment markers.
    - Cover explicit [] raw behavior and repeated global/sticky pattern use.
    - Assert kind/method/status/duration and non-URL payload fields remain exact.
  ENABLES: CX-5a, CX-5b
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-session-replay#test -- -t "redact|navigation|network"
    - EXPECTED: All named URL surfaces share exact, repeat-safe query/fragment behavior.

Task 4: Apply D1 and preserve peer-owned defaults in browser integration
  MODIFY packages/logfire-browser/src/browserSession.ts:
    - Change the default full page attribute to origin+pathname and retain pathname.
    - Update public comments; preserve false and callback behavior exactly.
  MODIFY packages/logfire-browser/src/BrowserSessionSpanProcessor.test.ts and browserSession.test.ts:
    - Assert default omission of query/fragment and exact raw/custom/false behavior.
  MODIFY packages/logfire-browser/src/index.test.ts:
    - Update the public configure/tracer matrix so default, raw callback, sanitized callback, and disabled page attributes are exact.
  MODIFY packages/logfire-browser/src/sessionReplay.ts:
    - Add maskAllText to public/package config types and bridge it only when explicitly supplied.
    - Stop assigning empty redactUrlPatterns when absent so standalone defaults apply; continue forwarding explicit [] and custom patterns.
  MODIFY packages/logfire-browser/src/sessionReplay.test.ts:
    - Assert omitted privacy fields stay absent and explicit true/false/[]/patterns preserve caller intent.
    - Exercise { maskAllText: false, maskTextSelector: '.secret' } through the public browser replay bridge, not only the recorder unit seam.
    - Retain config-assignability coverage against the peer package type.
  ENABLES: CX-5a, CX-5b
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-browser#test -- -t "page URL|replay|privacy"
    - EXPECTED: Public page attributes and peer config use the settled defaults without browser-side shadow defaults.

Task 5: Update the privacy-safe example and public contract documentation
  MODIFY examples/browser-rum-replay/src/main.ts:
    - Remove the editable user identifier from console payloads; use only a non-sensitive constant/boolean if the explicit console demo remains.
    - Use or explicitly demonstrate the stable text/URL defaults without a narrower redaction policy silently weakening them.
  MODIFY examples/browser-rum-replay/README.md:
    - Explain any deliberate console/text opt-in and state that editable identifiers/secrets must not be logged.
  MODIFY packages/logfire-session-replay/README.md, packages/logfire-browser/README.md, docs/packages/browser.md:
    - Document default maskAllText=true, maskAllInputs=true, captureConsole=false, sanitized page/network/navigation URLs, and exact opt-ins.
    - Explain that text masking does not sanitize DOM attributes/CSS/custom events and point to blockSelector/safe markup.
    - Treat docs/packages/browser.md as the sole generated-style package-doc target; no standalone replay package page exists.
  CREATE reports/pr-161-platform-privacy-handoff.md:
    - Provide the exact replacement stable page examples using origin+pathname and describe the Platform callback as defense-in-depth rather than the sole sanitizer.
    - Preserve the separate page-vs-network query contract and legacy fallback, and name the adjacent report to update in a separately authorized Platform task.
  CREATE .changeset/browser-replay-privacy-defaults.md:
    - Add patch notes for both packages; leave final stable version reconciliation to R8.
  ENABLES: CX-5a, CX-5b
  VERIFY:
    - COMMAND: vp fmt --check packages/logfire-session-replay/README.md packages/logfire-browser/README.md docs/packages/browser.md examples/browser-rum-replay/src/main.ts examples/browser-rum-replay/README.md .changeset/browser-replay-privacy-defaults.md
    - EXPECTED: In-repository public docs/example/release note are formatted and agree on defaults/opt-ins.
    - COMMAND: rg -n "location.href, including|captureConsole.*default|maskAllText|query strings and fragments" packages/logfire-browser/README.md packages/logfire-session-replay/README.md docs/packages/browser.md examples/browser-rum-replay/README.md reports/pr-161-platform-privacy-handoff.md
    - EXPECTED: No stale in-repo target-stable raw-default claim remains; each relevant contract and the separate Platform amendment are explicit.

Task 6: Build direct default and opt-in privacy acceptance
  CREATE packages/logfire-browser/test-fixtures/privacy-defaults/index.html and main.ts:
    - Render distinct visible-text and input secret markers before public configuration, then mutate visible text after recording starts.
    - Include one non-sensitive query-bearing DOM attribute marker and treat it only as evidence for the documented DOM-attribute non-claim.
    - Select default vs opt-in configuration from the route; use rum.session, built replay lazy loading, fixed same-origin trace/replay endpoints, long auto flush, and public flush/cleanup controls.
    - Emit one manual span, console marker, fetch and XHR URLs with query/fragment markers, and push/replace/pop navigation markers; await a recorder-visible turn after each mutation/navigation and public flush before setting phase complete.
  CREATE packages/logfire-browser/test-fixtures/privacy-defaults/recorder.d.ts and vite.config.ts:
    - Reuse self-observation's built replay/rrweb/fflate virtual-module pattern.
    - Bind loopback port 4178, reset scenario-keyed receipts, accept OTLP trace and replay uploads, and serve application routes without credentials or forwarding.
  CREATE packages/logfire-browser/test-fixtures/privacy-defaults/verify.mjs:
    - Poll and freeze scenario receipts, decode trace OTLP JSON and gzip replay envelopes, then inspect exact span attributes and replay event fields.
    - Extract an explicit claimed-field allowlist: logfire.page.url.full/path, rrweb Meta data.href, Logfire Network payload.url plus method/status/duration, Logfire Navigation payload.url plus kind, Console payloads, relevant serialized text/input values, and every ChunkEnvelope.meta.urls entry.
    - For default, require origin+pathname page attributes, masked initial/mutated/input markers, no Console event, sanitized rrweb Meta/navigation/fetch/XHR URLs and meta.urls, preserved metadata, and absence of named secrets only in that claimed-field allowlist.
    - For opt-in, require raw page/full URL, visible initial/mutated text, Console event, raw navigation/network URLs, and raw meta.urls while input remains masked.
    - Assert the benign query-bearing DOM attribute remains outside the claimed sanitizer allowlist so the documented non-claim is tested without a whole-envelope secret scan.
    - Fail nonzero on missing/duplicate evidence; print a bounded summary with no secret values.
  ENABLES: CX-5a, CX-5b
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-session-replay#build && vp run @pydantic/logfire-browser#build
    - EXPECTED: Fixture consumes built public outputs.
    - COMMAND: vp dev --config packages/logfire-browser/test-fixtures/privacy-defaults/vite.config.ts --host 127.0.0.1 --port 4178
    - EXPECTED: Loopback fixture starts and remains active for the Consumer Verification Plan.

Task 7: Run focused and integrated validation
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-session-replay#test && vp run @pydantic/logfire-session-replay#typecheck && vp run @pydantic/logfire-session-replay#build
    - EXPECTED: Standalone replay tests/types/build pass with exact privacy defaults.
    - COMMAND: vp run @pydantic/logfire-browser#test && vp run @pydantic/logfire-browser#typecheck && vp run @pydantic/logfire-browser#build
    - EXPECTED: Browser integration tests/types/build pass.
    - COMMAND: node_modules/.bin/changeset status --output /tmp/r5-changeset-status.json
    - EXPECTED: Changesets parses all files; the JSON contains browser-replay-privacy-defaults with exactly browser/replay patch releases and still exposes the pre-existing R8-owned logfire-nextjs-example null version.
    - COMMAND: node --input-type=module -e "import { readFileSync } from 'node:fs'; const status=JSON.parse(readFileSync('/tmp/r5-changeset-status.json','utf8')); const item=status.changesets.find(({id})=>id==='browser-replay-privacy-defaults'); const releases=[...(item?.releases??[])].sort((a,b)=>a.name.localeCompare(b.name)); const expected=[{name:'@pydantic/logfire-browser',type:'patch'},{name:'@pydantic/logfire-session-replay',type:'patch'}].sort((a,b)=>a.name.localeCompare(b.name)); if(JSON.stringify(releases)!==JSON.stringify(expected)) process.exit(1);"
    - EXPECTED: The new R5 Changeset has exactly the intended two patch entries; no claim is made about final version validity.
    - COMMAND: pnpm run check
    - EXPECTED: The complete repository gate passes; detached version reconciliation remains R8-owned.
```

### Integration Points

```yaml
PUBLIC_BROWSER_CONFIG:
  - packages/logfire-browser/src/browserSession.ts — page URL default and callback escape hatch.
  - packages/logfire-browser/src/sessionReplay.ts — semantic replay option transport without shadowing peer defaults.

PUBLIC_REPLAY_CONFIG:
  - packages/logfire-session-replay/src/types.ts — exact default/override contract.
  - packages/logfire-session-replay/src/index.ts — controller wiring.

RRWEB_BOUNDARY:
  - packages/logfire-session-replay/src/recorder.ts — semantic text mapping and Meta href sanitization before buffering.

PRIVACY_HELPER:
  - packages/logfire-session-replay/src/privacy.ts — repeat-safe URL policy shared across independent recorder/capture boundaries.

CUSTOM_CAPTURE:
  - packages/logfire-session-replay/src/capture.ts — shared repeat-safe network/navigation URL sanitizer.

DOWNSTREAM_HANDOFF:
  - reports/pr-161-platform-privacy-handoff.md — exact amendment for a separately authorized update to the adjacent Platform follow-up.

RELEASE:
  - .changeset/browser-replay-privacy-defaults.md — focused package-visible patch note; R8 owns final simulation.
```

## Validation

```bash
vp run @pydantic/logfire-session-replay#test
vp run @pydantic/logfire-session-replay#typecheck
vp run @pydantic/logfire-session-replay#build
vp run @pydantic/logfire-browser#test
vp run @pydantic/logfire-browser#typecheck
vp run @pydantic/logfire-browser#build
node_modules/.bin/changeset status --output /tmp/r5-changeset-status.json
node --input-type=module -e "import { readFileSync } from 'node:fs'; const status=JSON.parse(readFileSync('/tmp/r5-changeset-status.json','utf8')); const item=status.changesets.find(({id})=>id==='browser-replay-privacy-defaults'); const releases=[...(item?.releases??[])].sort((a,b)=>a.name.localeCompare(b.name)); const expected=[{name:'@pydantic/logfire-browser',type:'patch'},{name:'@pydantic/logfire-session-replay',type:'patch'}].sort((a,b)=>a.name.localeCompare(b.name)); if(JSON.stringify(releases)!==JSON.stringify(expected)) process.exit(1);"
vp fmt --check packages/logfire-session-replay packages/logfire-browser docs/packages/browser.md examples/browser-rum-replay .changeset/browser-replay-privacy-defaults.md plans/027-browser-privacy-defaults.md
pnpm run check
```

The executor must also run both exact built-package browser scenarios. Package
tests and the jsdom spike do not satisfy the consumer contract:

```bash
vp dev --config packages/logfire-browser/test-fixtures/privacy-defaults/vite.config.ts --host 127.0.0.1 --port 4178

# CX-5a: privacy-safe defaults
agent-browser --session r5-default open "http://127.0.0.1:4178/default/?page_secret=default-page-secret#default-fragment-secret"
agent-browser --session r5-default wait --fn "window.__logfirePrivacyDefaults?.phase === 'complete'"
node packages/logfire-browser/test-fixtures/privacy-defaults/verify.mjs default
agent-browser --session r5-default close

# CX-5b: deliberate raw-data opt-ins
agent-browser --session r5-opt-in open "http://127.0.0.1:4178/opt-in/?page_secret=opt-in-page-secret#opt-in-fragment-secret"
agent-browser --session r5-opt-in wait --fn "window.__logfirePrivacyDefaults?.phase === 'complete'"
node packages/logfire-browser/test-fixtures/privacy-defaults/verify.mjs opt-in
agent-browser --session r5-opt-in close
```

### Required Test Coverage

- [x] D1 default, raw callback, sanitized callback, and disabled page attributes
      through public browser configuration.
- [x] `maskAllText` true/false/omitted and its precedence over selective
      `maskTextSelector`, including public standalone and browser-bridge
      `{ maskAllText: false, maskTextSelector: '.secret' }` coverage.
- [x] Console capture omitted by default and explicit opt-in preserved.
- [x] Default universal, selective, global/sticky, and explicit-empty URL
      patterns across rrweb Meta, fetch, XHR, push, replace, and pop.
- [x] Browser bridge omits absent privacy options and forwards explicit false,
      true, custom patterns, and empty arrays unchanged.
- [x] Example console payload contains no editable identifier and docs state the
      exact capture risk.
- [x] Real rrweb initial snapshot, later text mutation, input value, console,
      page Meta, network, navigation, envelope `meta.urls`, and exported span
      fields under defaults using an exact claimed-field allowlist.
- [x] The same real-browser surfaces under deliberate raw-data opt-ins.

### Consumer Verification Plan

| Scenario | Exercise                                                                                                                                                                                  | Expected observable evidence                                                                                                                                                                                                                         | Environment and prerequisites                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `CX-5a`  | Build both packages; open the default privacy fixture with page, DOM, input, console, fetch/XHR, and SPA secret markers; await every asynchronous action, flush, and decode receipts      | Origin+pathname page attributes; masked initial/mutated/input values; no Console event; sanitized rrweb Meta/network/navigation URL fields and envelope `meta.urls` with method/status/kind retained; no secret in the exact claimed-field allowlist | Node 24.14.1, pnpm 11.5.2, Vite+ loopback 4178, agent-browser real browser, no credentials   |
| `CX-5b`  | Reset the agent-browser session; open the opt-in fixture with raw page callback, `maskAllText:false`, `captureConsole:true`, and `redactUrlPatterns:[]`; await actions, flush, and decode | Raw page URL, visible initial/mutated text, console marker, raw network/navigation URLs, and raw envelope `meta.urls` appear exactly; input remains masked                                                                                           | Same built packages/loopback browser fixture, isolated scenario receipts and browser storage |

## Unknowns & Risks

- rrweb text masking does not cover DOM attributes, CSS, resource URLs, custom
  events, or caller-defined identifiers. This is an explicit non-claim and must
  be prominent enough that consumers do not infer whole-payload scrubbing.
- Query stripping can reduce replay fidelity for applications whose route or
  resource behavior depends on query values; explicit `redactUrlPatterns: []`
  and raw page callbacks preserve an intentional opt-in path.
- The public `maskAllText` option is implemented through rrweb's selector
  primitive. The direct browser fixture is mandatory because the initial probe
  covered only full-snapshot serialization in jsdom.
- The adjacent Platform report remains stale until a separately authorized
  Platform-repository task applies the committed in-repo amendment. R9 must not
  treat the handoff as applied merely because R5 is verified.

**Confidence: 8/10** for one-pass implementation success. The code paths are
bounded and the all-text mechanism was spiked; exact real-browser event-shape
assertions are the main remaining execution risk.

## Execution Notes

- The final root lint gate required a validation-only type-annotation cleanup
  in the existing self-observation fixture; behavior and scope are unchanged.
- The adjacent Platform repository was not modified. The exact separately
  authorized amendment is recorded in
  `reports/pr-161-platform-privacy-handoff.md`.

## Verification Record

- **Verified**: 2026-07-13 from source baseline `7cfa9f7` with the preserved
  uncommitted PRP, spike, and roadmap records.
- **Focused package gates**: replay typecheck and 146/146 tests passed; browser
  typecheck and 145/145 tests passed.
- **Release metadata**: Changesets parsed
  `browser-replay-privacy-defaults` with exactly patch releases for
  `@pydantic/logfire-browser` and `@pydantic/logfire-session-replay`.
- **Direct consumer evidence**: built packages and actual rrweb passed both
  exact port-4178 scenarios. `CX-5a` proved origin+pathname page attributes,
  masked initial/mutated text and initial/incremental inputs, no replay console
  event, exact sanitized Meta/fetch/XHR/push/replace/pop/envelope URLs, and the
  deliberate raw DOM-attribute non-claim. `CX-5b` proved raw page/replay URLs,
  visible initial/mutated text, one explicit console marker, real history-back
  pop capture, and input masking retained.
- **Integrated gate**: `pnpm run check` passed package builds, formatting,
  lint, all package typechecks, and all package tests.
- **Independent Deep review**: the first post-implementation review found four
  acceptance-fixture weaknesses. After exact per-surface assertions, marker
  alignment, initial-input/DOM-attribute evidence, and real history traversal
  were added, the read-only re-review reported no remaining findings.
