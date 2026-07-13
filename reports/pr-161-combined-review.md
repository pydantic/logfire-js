# Combined review: PR #161 — stable browser RUM and session replay release

Reviewed: 2026-07-13. Scope: PR #161 against `main`, combining the independent
engineering review in `reports/pr-161-review.md` with CodeRabbit's 19 unresolved
inline threads and eight test-quality nitpicks.

## Executive summary

PR #161 graduates the browser RUM work from alpha to stable. It adds the
standalone `@pydantic/logfire-session-replay` package, expands
`@pydantic/logfire-browser` with browser sessions, Web Vitals and replay
integration, exits Changesets prerelease mode, and prepares stable versions
`@pydantic/logfire-browser@0.17.0` and
`@pydantic/logfire-session-replay@0.1.0`.

The implementation is generally strong: startup and teardown are mostly
transactional, global patches coexist with later third-party wrappers, teardown
is idempotent, and the new behavior has roughly 185 tests. The release mechanics
and intended version math were reproduced successfully.

The PR should not merge in its current state. The two reviews jointly identify:

- six independently reproduced major defects in telemetry suppression,
  reconfiguration, unload delivery, compression and Changesets handling;
- additional confirmed security and reliability defects in the documented
  replay proxy path, example servers, host callbacks and token tooling;
- one public privacy-default decision that should be settled before the first
  stable release; and
- one CodeRabbit proposal that should not be implemented as written because it
  could turn an authentication failure into an unauthenticated metrics export.

## Disposition legend

- **Blocker**: fix before merge or stable publication.
- **Should fix**: bounded correctness, resilience, documentation or test work
  appropriate for this PR.
- **Decision**: requires explicit stable-contract or privacy-policy sign-off.
- **Decline as written**: the observation may be useful, but the proposed remedy
  introduces a regression.
- **Follow-up**: valid improvement that may be deferred if consciously recorded.

## Consolidated blockers

### B1. Relative telemetry URLs are not suppressed from replay capture

Source: independent review major 1.

`packages/logfire-browser/src/sessionReplay.ts` constructs anchored ignore
patterns from configured URLs. OTLP transport converts a relative URL such as
`/logfire-proxy/v1/traces` to an absolute URL before calling `fetch`, so the
relative pattern does not match. Replay then records the SDK's own trace, metric
and replay uploads, allowing self-sustaining traffic.

Required change: normalize configured and observed URLs with the current page as
the base while retaining coverage for directly issued relative requests. Add a
relative-configuration/absolute-request regression test.

### B2. Replay's fetch wrapper hides OpenTelemetry's `__original` escape hatch

Source: independent review major 2.

The OTLP fetch transport uses `fetch.__original` to bypass fetch instrumentation
and prevent export-generated spans. Replay's later-installed wrapper does not
propagate that property, so `autoInstrumentations` plus replay can re-enable the
export → span → export loop.

Required change: propagate `original.__original ?? original` to the wrapper and
cover the interaction in an integration-style test. Consider injecting the
absolute telemetry URLs into the default fetch/XHR instrumentation ignore lists.

### B3. Cleanup followed by `configure()` can silently drop manual spans

Source: independent review major 3.

Cleanup shuts down the first provider but leaves it in the OpenTelemetry global
registry. A later provider cannot replace it, so manual `logfire.*` calls still
delegate to the shut-down provider while other paths can appear functional. The
current provider mock masks this because its fake shutdown disables the global
registry, unlike the real provider.

Required change: guardedly disable the trace, context and propagation globals
owned by this configuration during cleanup. Test configure → cleanup → configure
against real registry semantics.

### B4. Multi-chunk unload delivery starts only the first keepalive request

Source: independent review major 4.

Keepalive flush splits replay data into chunks but waits for each response before
starting the next request. A page can terminate while awaiting chunk zero, so
later chunks are never initiated.

Required change: initiate permitted keepalive requests without serially awaiting
responses, while respecting the browser's cumulative keepalive quota, or use a
carefully bounded `sendBeacon` path. Exercise a multi-chunk page-exit scenario.

### B5. Worker-based gzip failure permanently drops periodic replay data

Source: independent review major 5.

Periodic delivery relies on fflate's Worker created from a Blob URL. CSPs that
disallow `worker-src blob:` make every periodic compression attempt fail after
the buffer has been swapped out.

Required change: fall back to synchronous gzip after an async-worker failure and
memoize the fallback. Verify that the failed batch is still delivered.

### B6. Changesets can write `"version": null` for the Next.js example

Source: independent review major 6.

`examples/nextjs/package.json` has no version. The installed Changesets exit-mode
path can force it into a patch release and evaluate `semver.inc(undefined,
'patch')`, producing a null version and junk changelog entry.

Required change: add `"version": "0.0.0"` to the private example and rerun the
isolated `changeset version` verification.

### B7. The documented Python proxy cannot forward replay

Source: CodeRabbit thread 1.

The browser docs configure replay at `/logfire-proxy/v1/replay`, then recommend a
FastAPI catch-all backed by `logfire.forward_export_request_starlette`. That
helper explicitly accepts only traces, logs and metrics, so a reader following
the combined instructions receives a failure for replay.

Required change: document and provide a separately authenticated replay relay,
or clearly separate replay proxy guidance from the telemetry helper and state
that it cannot forward replay.

### B8. Example token-injecting proxies are exposed too broadly

Sources: CodeRabbit thread 5; independent security review.

The example proxy uses wildcard CORS with credentials and listens on all network
interfaces while attaching a server-side Logfire token. This is an unsafe
reference posture and the wildcard/credentials combination is invalid in
browsers.

Required change: bind to loopback, allow only the local Vite origin or an
explicit configured allow-list, remove credentialed wildcard CORS, encode query
parameters, and document the development-only boundary.

### B9. Proxy request failures and oversize bodies can hang or reset clients

Sources: CodeRabbit threads 6 and 8; independent release/example review.

The original browser example uses Express 4 async handlers without catching
rejected upstream `fetch` calls. Both replay body readers destroy the incoming
request before their catch path can reliably send a 413, which can surface as a
connection reset.

Required change: catch proxy failures and return 502, and implement bounded body
handling that drains or safely terminates the request while still delivering a
413 response. Cover both example proxies.

### B10. Optional replay callbacks can escape into host timers and rrweb

Source: CodeRabbit thread 17.

Throwing `getSessionId` and `getTraceContext` callbacks escape the session poll,
trace poll or rrweb event callback. That violates the replay integration's
host-safety contract.

Required change: catch callback failures, report through the guarded `onError`
path, and skip only the affected observation or event. Add interval and recorder
callback tests. Public synchronous methods may retain explicitly documented
throwing behavior only if that is deliberate.

### B11. Replay navigation capture can expose sensitive URLs

Source: CodeRabbit thread 15; related to the independent privacy review.

Network capture applies `redactUrlPatterns`, but navigation capture always emits
`window.location.href`. The new example deliberately navigates to a URL
containing `?token=route-secret`, so its configured token-redaction pattern does
not protect the navigation event.

Required change: apply the normalized URL-redaction configuration to navigation
events and test query/fragment removal. This is required even if the broader
default-page-URL decision below retains raw URLs by default.

### B12. The npm token helper exposes the secret in process arguments

Sources: CodeRabbit thread 19; independent security review.

`scripts/create-npm-token.sh` passes the token using `gh secret set --body`, so it
can be visible through process inspection.

Required change: pipe the token to `gh secret set` over standard input and retain
the existing temporary-file cleanup behavior.

### B13. The replay example logs an editable user identifier into replay

Source: CodeRabbit thread 4.

The example enables console capture and includes `getUserId()` in a
`console.warn`, recording user-provided text through a side channel despite the
DOM input-masking posture.

Required change: remove or replace the identifier with a non-sensitive constant
or boolean state, and keep the example explicit about console-capture risk.

## Stable-contract and privacy decisions

### D1. Default page URL attributes

Sources: CodeRabbit threads 9 and 12.

The current documented contract emits:

- `logfire.page.url.full = location.href`, including query and fragment;
- `logfire.page.url.path = location.pathname`.

This is intentional and configurable through `rum.session.urlAttributes`, so it
is not an accidental correctness bug. It is nevertheless a risky privacy
default for a stable browser SDK: reset links, search terms, email addresses and
application secrets are frequently carried in query strings or fragments.

Recommended decision: make the default full value `${url.origin}${url.pathname}`
and require explicit customization to retain query or fragment data. Update the
README, docs, tests and the Platform follow-up report. Platform sanitization is
still valuable for older SDKs and custom attribute callbacks.

### D2. Replay text and side-channel defaults

Source: independent security review.

Inputs are masked, canvas and fonts are disabled, and request/response bodies are
not captured. However, visible DOM text, full URLs and console arguments can be
captured by default. Sentry-like products generally choose a stronger default
for text masking.

Decision required: either explicitly accept and document the current default,
or add a `maskAllText`-style control and choose a privacy-safe initial value
before `@pydantic/logfire-session-replay@0.1.0` is published.

### D3. Public replay lifecycle handle

Source: independent browser-package review.

The browser integration does not expose replay `flush`, `stop` or current mode,
although lifecycle guidance recommends flushing before controlled navigation.
This can be added later without a breaking change, but the omission should be a
recorded stable-API decision rather than an accident.

### D4. API placement

Source: independent browser-package review.

`sessionReplay` is top-level while Web Vitals is under `rum`, even though both
imply RUM sessions. The asymmetry is defensible, but should receive an explicit
sign-off before the stable release.

## CodeRabbit proposal to decline as written

### X1. Do not replace a failing metrics-header callback with `{}`

Source: CodeRabbit thread 11.

The concern is that `metricExporterHeaders` can throw or reject during export.
CodeRabbit proposed catching the failure and continuing with empty headers. For
authenticated proxies this converts a credential-resolution failure into an
unauthenticated request, which is a security and correctness regression.

Preferred handling: ensure the exporter failure is contained from the host app,
diagnosed without leaking credentials, and treated as a failed export. Do not
send the batch without the caller-requested headers. Add a test for synchronous
throw and asynchronous rejection.

## Confirmed should-fix items

### Runtime and lifecycle

1. Re-check `active` after `addCustomEvent` before promoting/flushing buffered
   replay, preventing a post-rotation interval leak and old-session upload.
2. Enforce `maxBufferBytes` in buffer mode, not only full mode.
3. Debounce internal session activity persistence; rrweb events and span starts
   currently cause excessive synchronous `sessionStorage` I/O.
4. Add a reentrancy guard around console capture/error reporting so a logging
   `onError` cannot recurse to stack overflow.
5. Coerce non-string rejection messages with `String(...)` before constructing
   typed error payloads.
6. Guard replay-state getters in the span processor; a hostile or broken loaded
   module must not break every application `startSpan()` call.
7. Decide whether a metrics startup failure should degrade to Web Vitals spans
   only instead of disabling both metrics and spans.
8. Validate empty replay and metrics URLs consistently at configuration time.
9. Clarify that browser-session inactivity currently means span inactivity when
   replay continues without new spans.

### CodeRabbit correctness and resilience

10. Handle rejected catalog, XHR and checkout actions in the replay example and
    replace loading states with a visible failure state (thread 3).
11. Handle the basic browser example's rejected fetch workflow similarly
    (thread 7).
12. Suppress false `missing Web Vitals tracer` diagnostics from callbacks that
    arrive after shutdown, while retaining diagnostics for real active-runtime
    failures (thread 14; overlaps the independent review).
13. Count string request bodies with UTF-8 bytes via `TextEncoder`, not UTF-16
    code units, and add a non-ASCII test (thread 16). Apply the same byte-accurate
    principle to replay buffer and keepalive estimates noted by the independent
    review.
14. Retry replay HTTP 429 responses like other transient failures; preferably
    honor `Retry-After` when practical (thread 18).
15. Add the asynchronous replay-credential/unload caveat from the standalone
    replay README to the browser README and browser docs (thread 10).
16. Change the optional example environment loading to
    `--env-file-if-exists=.env` and add `.env.example` where missing (thread 2).
    Node 24 supports this flag; removing environment-file support is unnecessary.

### Cleanup and dead surface

17. Remove or wire up the production-dead `ReplayTransport.rotate()` and
    `RecorderHandle.takeFullSnapshot` APIs.
18. Remove the unused `'load'` member from `NavigationPayload.kind`, or emit and
    test an initial load event.
19. **Dispositioned as obsolete:** keep the replay test import on
    `vite-plus/test`. The repository's completed Vite+ migration now uses that
    import consistently across browser and replay tests, so changing only
    `capture.test.ts` back to `vitest` would introduce inconsistency.

### Stable span semantics

20. Stamp point-in-time Web Vitals spans with
    `logfire.span_type = 'log'` and test the exact attribute. Platform RUM
    queries identify these records by `web_vital.*` names/attributes, so the
    canonical Logfire point-event type does not conflict with aggregation or
    drilldown behavior. This is owned by roadmap R6.

## Documentation, examples and release notes

1. Restore an `autoInstrumentations` line to the stable browser changelog. The
   alpha-era release note was replaced, but the feature is central to the stable
   documentation.
2. State that the Vite replay examples require the workspace packages to be
   built first, or remove their formatting-sensitive `from"rrweb"` replacement.
3. Reconsider the browser example's default Logfire URL. Port 3000 targets an
   internal development stack rather than the standard external OTLP endpoint.
4. Keep the direct-browser-token path clearly marked as an advanced escape hatch;
   the normal deployment model should remain an authenticated backend proxy.

## Test-strengthening work

CodeRabbit's deterministic-assertion thread and eight nitpicks align with the
repository guide. They are not release blockers by themselves, but are cheap to
address while touching the affected tests:

- use exact `toEqual` assertions for stable session attributes, Web Vitals
  tracer registrations, recorder sampling configuration and deterministic
  diagnostic strings;
- assert the `maxBufferBytes` upload before shutdown so shutdown cannot make the
  test pass accidentally;
- test interval behavior through observable replay uploads rather than only a
  timer spy;
- assert exact truncation output for deterministic console serialization; and
- retain partial matching only where the object intentionally contains unstable
  or implementation-owned fields.

Additional high-value gaps from the independent review:

- absolute exporter URLs against relative ignore configuration;
- fetch-wrapper interaction with OpenTelemetry's `__original` convention;
- real OpenTelemetry registry behavior across configure/cleanup/reconfigure;
- multi-chunk unload initiation;
- CSP/Worker compression fallback without dropping the batch;
- metrics startup failure with Web Vitals spans enabled;
- cleanup while asynchronous replay startup is in flight;
- session storage failures; and
- end-to-end verification of masking defaults through resolved configuration.

## Release mechanics already verified

- Isolated `changeset version` produces browser `0.17.0` and replay `0.1.0` with
  no unintended public-package versions, apart from the private Next.js example
  defect described in B6.
- Prerelease metadata and changeset files are removed by the version operation.
- No branch-specific alpha workflow remains in `.github/`, `scripts/` or the root
  package scripts.
- Publishing through pnpm rewrites workspace/catalog protocols correctly, and
  replay's published files are limited to `dist` plus the license.
- Publishing the stable replay version will move npm's `latest` tag away from
  the current alpha; obsolete `alpha` dist-tags may then be removed separately.
- When replay reaches `0.2.0`, the browser package's `^0.1.0` optional peer range
  becomes out of range and Changesets may correctly propose a major browser bump.

## Recommended execution order

These are bounded review fixes with clear validation paths; they do not require
a new PRP phase. Use the existing stable-release PRP as the release contract.

1. Fix B1-B5 first and run focused browser/replay tests after each dependency
   cluster.
2. Fix the proxy, callback, URL-redaction and token-tooling blockers B7-B13.
3. Resolve D1 and D2 before changing public defaults; the recommended choice is
   privacy-safe page URLs and an explicit text-masking policy.
4. Apply the should-fix runtime, docs and deterministic-test changes.
5. Add the Next.js version, restore the release-note coverage, and rerun the
   isolated Changesets version simulation.
6. Run `pnpm run check`, inspect the complete diff, and exercise the documented
   proxy + `autoInstrumentations` + replay configuration outside-in.
7. Push the fixes, respond to CodeRabbit with the rationale for X1, and resolve
   threads only after the corresponding validation evidence is available.
8. Merge only after CI and review are green; then allow the stable release PR to
   version and publish the packages.

## Merge gate

PR #161 is ready to merge only when:

- all blocker items are fixed and regression-tested;
- D1 and D2 have explicit recorded decisions reflected in docs and defaults;
- the metrics-header failure path never exports without required credentials;
- the Changesets simulation produces only valid versions and changelogs;
- the documented browser proxy/replay path works as written;
- the full repository check passes; and
- unresolved review threads are either fixed or answered with a verified
  rationale.
