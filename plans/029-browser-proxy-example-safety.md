# Browser Proxy and Example Safety

## Goal

Make both standalone browser example proxies safe, truthful development
references: they bind to loopback, accept only explicit frontend origins,
forward trace, metric, and replay traffic exactly, and return deterministic
errors. Make the actual browser examples settle every rejected workflow into a
visible failure state, and separate Python telemetry-only proxy guidance from
replay guidance.

## Why

- Developers currently following the examples can expose a server-side Logfire
  write token to other network clients and arbitrary browser origins.
- Oversized replay bodies and rejected upstream fetches can reset, hang, or
  escape Express 4 handlers rather than returning a usable response.
- The documentation combines a replay URL with Python helpers that explicitly
  support only traces, logs, and metrics.
- Rejected example actions currently leave `loading` status visible and create
  unhandled promise rejections, which makes the examples poor failure-path
  references and prevents reliable R9 integration.

## Success Criteria

- [x] Both `examples/browser` and `examples/browser-rum-replay` proxy servers
      bind to `127.0.0.1` by default, inject only a server-side token, and enforce
      a finite exact origin allow-list with no credentialed wildcard CORS.
- [x] The server environment contract is literal and shared:
      `HOST=127.0.0.1`, example-specific `PORT`, `LOGFIRE_ALLOWED_ORIGINS`,
      standard `https://logfire-api.pydantic.dev/v1/{traces,metrics,replay}`
      upstreams, and a required placeholder-only `LOGFIRE_TOKEN` template.
- [x] Both proxies forward valid trace, metric, and gzip replay requests with
      byte-preserving bodies, expected headers, and exactly encoded replay path
      and `seq` query components.
- [x] Content-length and chunked oversized requests receive a completed JSON
      `413` response without a reset or hang; rejected upstream requests receive
      a completed JSON `502` response, and each server remains usable afterward.
- [x] Catalog, XHR, checkout, and basic-fetch rejection paths end their loading
      state, show a stable visible failure, and create no `unhandledrejection`.
- [x] The browser docs state unambiguously that the Python forwarding helpers
      are telemetry-only and do not support replay; JavaScript replay proxy
      guidance remains a separate development-only capability.
- [x] The examples document the workspace build prerequisite, optional `.env`
      loading, complete templates, safe same-origin browser defaults, and the
      authenticated backend-proxy deployment model.
- [x] Direct outside-in evidence satisfies parent scenarios `CX-6` and `CX-7`
      using only loopback servers, local fake upstreams, a sentinel token, and a
      real browser.

## Assurance

- **Profile**: Deep
- **Rationale**: R7 changes a material credential-injection and network-origin
  security boundary. A mistake can expose a project write token or turn an
  example into an unauthenticated ingestion relay. It also coordinates two
  independently runnable Express 4 servers with trace/metric/replay body
  handling and two browser UIs with different rejection mechanisms (fetch and
  XHR). Research therefore covered the inherited R1-R6 contracts, both complete
  proxy/example implementations, public browser/replay documentation, exact
  installed stack, and the existing loopback real-browser fixture patterns. A
  fresh-context cold review is required for security, scenario coverage, and
  outside-in testability.

## Roadmap Context

- **Parent roadmap**: `plans/roadmaps/001-browser-rum-release-remediation.md`
- **Roadmap step**: `R7` — Make documented proxies and examples safe and
  truthful.
- **Satisfied dependencies**: R1-R6 are verified at
  `c628404ede63647fa0630e7f2f0daa7dc372cdb4`. R5 supplies the final
  privacy/example wording; R6 supplies the final replay lifecycle and
  degradation documentation contract.
- **Inherited decisions and invariants**:
  - preserve relative/same-origin trace, metric, and replay endpoint suppression
    from R1;
  - preserve replay's gzip POST contract
    `{replayUrl}/{encodeURIComponent(sessionId)}?seq={encoded seq}`, the replay
    envelope, headers, retry semantics, and lifecycle caveats from R3;
  - preserve R4 host containment and never retry authenticated work without the
    required headers;
  - preserve R5 privacy-safe defaults and example warnings; do not reintroduce
    editable identifiers into captured console data;
  - preserve R6's top-level `sessionReplay` placement and callable cleanup with
    optional generation-scoped `cleanup.sessionReplay`;
  - keep direct browser tokens an advanced escape hatch; the normal model is an
    authenticated backend proxy.
- **Contract produced for later steps**: a secure loopback development proxy
  contract and a reproducible proxy/UI environment that R9 can combine with the
  verified browser/replay runtime.

## Consumer Contract

### Consumer and Public Boundary

- **Consumer(s)**: developers running the two standalone Vite browser examples,
  browser SDK integrators reading the package/docs proxy guidance, browser users
  interacting with the example pages, and R9's final integration verifier.
- **Public or supported boundary**: documented proxy routes
  `/client-traces`, `/client-metrics`, and
  `/client-replay/:sessionId?seq=...`; proxy environment variables and startup
  scripts; the catalog/XHR/checkout/basic-fetch buttons and visible status; the
  browser package README and `docs/packages/browser.md`.
- **Entry point and prerequisites**: Node 24.14.1, pnpm 11.5.2, workspace
  packages built from the repository root, a copied optional `.env` file or
  equivalent process environment, and a server-only Logfire write token.
  `LOGFIRE_ALLOWED_ORIGINS` accepts at most 16 comma-separated canonical
  `http:`/`https:` origins. Direct verification uses a sentinel token and
  loopback fake upstream only.
- **Current observable behavior**: both token-injecting servers use wildcard
  credentialed CORS, listen without a host, destructively terminate oversized
  replay requests, and differ on upstream rejection containment. Example action
  promises are discarded. Browser docs configure replay next to a Python helper
  that rejects replay.
- **Observable promise**: documented development routes work exactly for valid
  requests, reject unsafe origins and bounded failures deterministically, and
  every named UI action shows a settled failure without host-level rejection.
  Python telemetry-only and JavaScript replay capabilities are stated
  separately.
- **Must remain compatible with**: the three existing client route names,
  `LOGFIRE_URL`, `LOGFIRE_METRICS_URL`, `LOGFIRE_REPLAY_URL`,
  `LOGFIRE_TOKEN`, the replay wire envelope, the optional replay package, and
  R1-R6 documentation semantics.
- **Not claimed**: a production proxy deployment, changes to the Python Logfire
  repository, Python replay forwarding, arbitrary-origin browser ingestion,
  guaranteed replay delivery after page termination, or safety of a write token
  embedded in browser code.

### Acceptance Scenarios

| ID     | Given                                                                                                                                                                                                                                                                                    | When                                                                                                                                                                                                                                    | Then                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Exact exercise and prerequisites                                                                                                                                                                                                                                                                                                                  | Required evidence                                                                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `CX-6` | A developer follows either standalone example's documented local proxy setup with a sentinel server token, exact allowed Vite origin, and loopback fake trace/metric/replay upstreams                                                                                                    | The browser/client sends valid trace, metric, and encoded replay requests; a disallowed-origin request; content-length and chunked requests over the configured limit; and requests while each upstream route rejects or is unavailable | Valid requests reach the exact upstream path with byte-identical bodies, preserved content headers, one normalized `Bearer` token, and encoded replay session/`seq` components; disallowed origin is rejected without forwarding; oversize returns completed `413`; upstream rejection returns completed `502`; responses contain no credential/upstream detail; the server still answers a health request; the default listener address is `127.0.0.1` | Run each example's proxy contract suite against an in-process `127.0.0.1` fake upstream and its actual Express listener. Use a small test-only limit, sentinel token, deadlines, raw/chunked HTTP clients, exact receipts, and post-error health requests. Also inspect the running listener address and allowed/disallowed preflights.           | DIRECT REQUIRED — crosses both documented HTTP server boundaries without real services or credentials |
| `CX-7` | The actual basic and replay Vite example pages are running from built workspace packages, an `unhandledrejection` observer is installed before interaction, and the committed loopback action fixture is prepared to hold then release a success, HTTP 503, or socket-rejection response | A real browser triggers basic fetch, catalog fetch, inventory XHR, and checkout in isolated/reset journeys                                                                                                                              | Every action visibly enters loading; success mode reaches its expected result; HTTP and socket-rejection modes replace loading with the exact failure label; every failure retries and settles; controls remain enabled, the page stays responsive, and the observer records zero unhandled rejections                                                                                                                                                  | Build packages and examples; start the committed `127.0.0.1:8991` fixture and the actual Vite configurations with the explicit test-only `VITE_LOGFIRE_PROXY_ORIGIN=http://127.0.0.1:8991` direct-loopback override; run every row of the Validation matrix through isolated `agent-browser` sessions and fixture prepare/release/status controls | DIRECT REQUIRED — exercises the shipped example UI and real fetch/XHR event paths                     |

## Research Summary

### Vetted Repository Findings

- `plans/roadmaps/001-browser-rum-release-remediation.md:297-312` — R7 is
  bounded to B7-B9, owns `CX-6`/`CX-7`, and must produce the running proxy/example
  environment for R9. — **PRP impact**: keep SDK runtime and release mechanics
  out of scope.
- `reports/pr-161-combined-review.md:119-156` — the Python helper mismatch,
  broad token server exposure, Express 4 rejection escape, destructive body
  termination, query encoding, and both-proxy coverage are confirmed release
  findings. — **PRP impact**: these are completion gates, not optional cleanup.
- `reports/pr-161-combined-review.md:295-312,333-343` — all four rejected UI
  actions, optional env loading, missing template, build prerequisite, port-3000
  default review, and proxy-first wording are required. — **PRP impact**:
  examples/docs/manifests are first-class scope.
- `examples/browser/src/proxy.ts:10-16,23-49,66-117` and
  `examples/browser-rum-replay/src/proxy.ts:4-19,30-62,71-161` — both servers use
  credentialed wildcard CORS, destroy an oversized request, concatenate replay
  URLs manually, and omit the listener host; only the replay workbench catches
  telemetry fetch rejection. — **PRP impact**: validate both independently.
- `examples/browser/src/main.ts:4-17,66-79` and
  `examples/browser-rum-replay/src/main.ts:110-120,158-240` — browser endpoint
  defaults are absolute development origins and event handlers discard the
  four action promises. Fetch paths also parse non-2xx responses without an
  explicit check. — **PRP impact**: use backend-proxy defaults and a common
  settled-action pattern.
- `examples/browser/package.json:6-10` and
  `examples/browser-rum-replay/package.json:6-10` — proxy scripts require `.env`;
  only the replay example has a tracked template, and the basic Vite dev command
  does not explicitly bind loopback. — **PRP impact**: use
  `--env-file-if-exists=.env`, add both templates, and make hosts explicit.
- `examples/browser/vite.config.ts:10-22` and
  `examples/browser-rum-replay/vite.config.ts:10-22` — both read built replay
  output and rewrite its rrweb/fflate imports. — **PRP impact**: document and
  validate the root workspace build before either Vite example.
- `docs/packages/browser.md:365-454` — the Python helpers explicitly accept only
  traces/logs/metrics, but the separation from the earlier replay setup is not
  prominent enough to prevent the documented mismatch. — **PRP impact**: choose
  precise separation, not an unowned Python relay.
- `packages/logfire-session-replay/src/transport.ts:294-332` and
  `packages/logfire-session-replay/README.md:18-69` — replay emits gzip JSON to
  an encoded session path with a `seq` query and forwards content/auth headers.
  — **PRP impact**: fake-upstream receipts must compare raw body, headers, path,
  and query exactly.
- `packages/logfire-browser/test-fixtures/self-observation/vite.config.ts:35-117`
  and `packages/logfire-session-replay/test-fixtures/delivery/vite.config.ts:44-159`
  — loopback Vite middleware, scripted receipts, built-package loading, and
  agent-browser are verified outside-in patterns. — **PRP impact**: reuse this
  evidence style rather than real Logfire credentials.
- `examples/nextjs-client-side-instrumentation/proxy.ts:1-21` and
  `examples/nextjs-bun/proxy.ts:1-20` are same-origin Next.js framework rewrite
  handlers: they do not own a listener, CORS middleware, replay body reader, or
  B9 Express fetch handler. `examples/nextjs/proxy.ts` is only a redirect. —
  **PRP impact**: record them as reviewed and out of the two standalone
  Express-proxy implementation matrix; do not silently treat them as untested
  copies.

### External Constraints

- None. Exact behavior is controlled by repository code and the installed
  versions: Node 24.14.1, Express 4.22.1 (manifest range `^4.21.2`), CORS 2.8.5,
  tsx 4.22.4, Vite+ 0.2.1/core Vite 8.0.16, and pnpm 11.5.2. Node's installed
  help confirms `--env-file-if-exists`.

### Settled Decisions and Rejected Alternatives

- **Decision**: satisfy B7 by renaming/separating the Python section as
  telemetry-only, stating that its helpers reject `/v1/replay`, and pointing
  replay users to the separately authenticated replay endpoint contract and
  JavaScript development examples. — **Rationale**: this is fully supported
  within this repository and does not invent or modify a Python implementation.
- **Decision**: default browser-facing example URLs to relative/same-origin
  `/client-*` routes and let the Vite development configuration forward them to
  the loopback example server. Use `LOGFIRE_PROXY_TARGET` as the server-side
  Vite development target override. Retain an unset-by-default
  `VITE_LOGFIRE_PROXY_ORIGIN` only for direct loopback testing of browser CORS
  and genuine socket rejection; it is not the documented deployment/default
  path and may accept only an explicit `http://127.0.0.1:*` origin. Default server-to-Logfire
  upstreams literally to
  `https://logfire-api.pydantic.dev/v1/traces`,
  `https://logfire-api.pydantic.dev/v1/metrics`, and
  `https://logfire-api.pydantic.dev/v1/replay`, and require a server-only token.
  —
  **Rationale**: the browser never receives the token, and the example no longer
  implies direct browser ingestion or an internal port-3000 stack.
- **Decision**: use `LOGFIRE_ALLOWED_ORIGINS` for the browser allow-list. If
  unset, default to exactly the Vite dev and preview origins
  `http://127.0.0.1:{5173,4173}` in the basic proxy and
  `http://127.0.0.1:{5174,4174}` in the replay proxy. If set, split on commas, trim,
  require 1-16 non-empty unique canonical origins, and reject `*`, credentials,
  paths other than `/`, query, fragment, patterns, non-HTTP schemes, empty
  members, or duplicates before listening. Allow no-Origin server-to-server/CLI
  requests, but browser
  requests with an `Origin` header must exactly match a finite configured list.
  Reject `*` configuration; omit credentialed CORS. — **Rationale**: this
  supports Vite's same-origin development forwarding without creating an
  arbitrary-origin token relay.
- **Decision**: keep the existing 10 MiB production example body ceiling unless
  implementation evidence requires a smaller documented bound; make the limit
  injectable only for tests. Cover both declared-length and chunked overflow.
  — **Rationale**: R7 changes termination semantics, not the accepted replay
  envelope size.
- **Decision**: preserve upstream HTTP response statuses; reserve `502` for a
  rejected/unavailable upstream request and `413` for local body-limit rejection.
  Emit exact small JSON errors with `application/json` and no exception, URL,
  header, body, or token details: `{"error":"origin not allowed"}` for `403`,
  `{"error":"request body too large"}` for `413`, and
  `{"error":"upstream request failed"}` for `502`.
- **Decision**: upstream requests receive only body-relevant ingest headers:
  the incoming `Content-Type`, `Content-Encoding` when present, and one
  server-generated normalized `Authorization: Bearer ...`. Replace/drop any
  client `Authorization` and consume rather than forward `Cookie`, `X-CSRF`,
  `X-Logfire-Example`, proxy-auth, forwarding, connection, and other hop-by-hop
  headers. Preserve only upstream status, body, and safe `Content-Type` on the
  downstream response; never forward `Set-Cookie` or hop-by-hop response
  headers.
- **Rejected**: add a Python replay relay snippet or modify the Python Logfire
  repository. — **Reason**: explicitly outside R7 and not runnable/verified from
  this workspace.
- **Rejected**: wildcard CORS without credentials as the sole fix. —
  **Reason**: it still exposes token-backed ingestion to arbitrary web origins.
- **Rejected**: validate only one proxy because the files are similar. —
  **Reason**: the current Express rejection behavior already differs.
- **Rejected**: use live Logfire/Platform credentials for acceptance. —
  **Reason**: local raw receipts prove the route contract more exactly and
  safely.

### Spike Evidence

- None needed. The remaining reader/middleware organization is a reversible
  local implementation detail. The PRP does not assume a library limit handler
  is safe: both declared-length and chunked overflow must pass direct deadlines,
  response-completion, zero-forwarding, and post-error health checks before the
  implementation can be accepted.

### Validation Baseline

| Command                                         | Status                 | Observed or expected result                                                                                                             |
| ----------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `git status --short --branch` and `git show -s` | Verified               | Clean worktree; HEAD `c628404ede63647fa0630e7f2f0daa7dc372cdb4`, four commits ahead of remote                                           |
| `node -v` / `pnpm --version`                    | Verified               | `v24.14.1` / `11.5.2`                                                                                                                   |
| `vp run browser#build`                          | Verified               | TypeScript and Vite production build passed; 269 modules transformed                                                                    |
| `vp run browser-rum-replay#build`               | Verified               | TypeScript and Vite production build passed; 269 modules transformed                                                                    |
| `node --help` query for env flags               | Verified               | Both `--env-file` and `--env-file-if-exists` are available                                                                              |
| Existing example proxy/UI tests                 | Unavailable            | No `*.test.*` or `*.spec.*` files exist under either standalone browser example                                                         |
| `pnpm list ...` exact dependency query          | Unavailable            | pnpm store-index SQLite was outside the managed sandbox; exact installed versions were read from example-local package metadata instead |
| `pnpm run check`                                | Discovered but not run | Required after implementation; broad baseline was already verified by R6 at this source commit                                          |

### Research Coverage

- **Depth**: Deep
- **Inspected**: complete parent roadmap and combined review; complete R1-R6
  child plans and verification records through a fresh read-only lane, with
  main-agent vetting of every R7-controlling citation; complete browser package
  README, browser docs, replay README, both standalone example READMEs, HTML,
  source, proxy source, Vite/TypeScript config, manifests, tracked env template,
  relevant Changesets, exact replay transport/URL tests, Next.js proxy
  classification, root workspace/tool configuration, real-browser fixtures, and
  recent relevant history.
- **Not inspected**: Python Logfire source and Platform source because R7 cannot
  modify or verify them; unrelated Node/Cloudflare examples; external production
  deployments.
- **Research confidence**: HIGH — all public promises have direct local
  evidence surfaces and no high-impact empirical assumption remains.

## Execution Contract

- **Planned at commit**: `c628404`
- **Planning baseline**: clean worktree on
  `petyosi/browser-rum-alpha-release`; preserve any later user changes.

### Expected Changes

- `examples/browser/src/proxy.ts` and
  `examples/browser-rum-replay/src/proxy.ts` — safe configuration, bounded raw
  forwarding, exact replay URL construction, explicit errors, loopback startup.
- `examples/browser/src/proxy.test.ts` and
  `examples/browser-rum-replay/src/proxy.test.ts` — identical public HTTP
  contract matrix against local fake upstreams, plus implementation-specific
  routes.
- `examples/browser-rum-replay/test-fixtures/proxy-example-safety/server.mjs` —
  loopback success, HTTP-failure, and socket-rejection API/telemetry target for
  the actual UIs, with a control/status endpoint and exact CORS for both Vite
  origins.
- `examples/browser/src/main.ts` and
  `examples/browser-rum-replay/src/main.ts` — relative backend-proxy defaults,
  response checks, visible settled failures, rejection containment.
- `examples/browser/src/vite-env.d.ts`,
  `examples/browser-rum-replay/src/vite-env.d.ts`, and both `vite.config.ts`
  files — typed optional overrides and loopback Vite forwarding for same-origin
  defaults.
- Both example `package.json` files — loopback dev host, optional env file,
  focused proxy test task.
- `examples/browser/.env.example` and
  `examples/browser-rum-replay/.env.example` — complete safe templates with
  placeholders, loopback/origin settings, and standard upstream routes.
- Both example READMEs, `packages/logfire-browser/README.md`, and
  `docs/packages/browser.md` — development-only boundary, build/env steps,
  backend-proxy defaults, exact Python telemetry-only/replay separation, error
  behavior.
- `.changeset/browser-proxy-example-safety.md` — patch note for the published
  browser documentation/reference behavior; do not version private examples.

### Explicitly Out of Scope

- Python Logfire repository/source changes or a Python replay implementation.
- Production proxy deployment, generalized reverse-proxy middleware, rate
  limiting/authentication design, or a claim that origin checks replace
  application authentication.
- Browser/replay SDK runtime, public types, replay envelope/schema, sampling,
  delivery/retry, privacy defaults, or lifecycle changes.
- Next.js middleware redesign; those handlers were reviewed but do not share the
  standalone Express listener/body-reader contract owned by B8-B9.
- R8 Changesets simulation/token tooling and R9 combined integration/release.

### Scope Expansion Rule

Additional files may change only when necessary to satisfy `CX-6` or `CX-7`
without changing the chosen same-origin/development-only architecture. Record
each added file and rationale in Execution Notes. Pause for user direction if
work requires a new public SDK API, production proxy design, Python repository
change, replay schema change, or authentication policy beyond the explicit
local origin/token contract.

### Pause and Reassess If

- either example cannot be tested through an actual loopback Express listener
  without introducing a production dependency or changing its supported routes;
- safe deterministic `413` behavior requires accepting unbounded buffering or
  destroying the client connection before a response can complete;
- a proposed origin mechanism permits `*`, pattern/subdomain matching, or
  reflects arbitrary origins while injecting a token;
- the Python helper is found to support replay at the verified dependency
  version, contradicting the documented telemetry-only boundary;
- same-origin defaults break R1 endpoint suppression or require browser-visible
  credentials;
- implementation would overwrite later user changes.

## Context

### Key Files

- `examples/browser/src/proxy.ts` — basic standalone Express implementation and
  the uncaught async-handler exemplar.
- `examples/browser-rum-replay/src/proxy.ts` — second standalone implementation,
  demo API routes, and caught telemetry-failure exemplar.
- `examples/browser/src/main.ts` — basic fetch public journey.
- `examples/browser-rum-replay/src/main.ts` — catalog fetch, XHR, and checkout
  public journeys plus settled R5 privacy choices.
- `packages/logfire-session-replay/src/transport.ts` — canonical replay request
  path, query, content, and headers.
- `packages/logfire-browser/src/telemetryUrls.ts` — relative/absolute endpoint
  validation and suppression semantics that defaults must preserve.
- `packages/logfire-browser/test-fixtures/self-observation/` — closest
  trace/metric/replay fake-receipt and real-browser pattern.
- `packages/logfire-session-replay/test-fixtures/delivery/` — closest scripted
  replay upstream and deadline/receipt verifier pattern.
- `docs/packages/browser.md` — Python helper mismatch and public proxy posture.
- `.changeset/browser-replay-privacy-defaults.md` and
  `.changeset/browser-optional-feature-api.md` — final wording that R7 must not
  contradict.

### Gotchas

- Express 4.22.1 does not automatically contain rejected async route promises;
  every async forwarding handler must terminate through an explicit catch/error
  boundary.
- Calling `req.destroy()` after crossing the body limit can win the race against
  `res.status(413)`. Tests must use real sockets and deadlines, not only call a
  reader helper.
- Replay bodies are gzip bytes. Do not parse/re-stringify or implicitly decode
  them; telemetry should also be forwarded byte-for-byte with its content type.
- `encodeURIComponent(sessionId)` and a URL query builder are separate
  requirements. Interpolating decoded `seq` can inject a second query component.
- Browser authentication headers such as `X-CSRF` or `X-Logfire-Example`
  authenticate the request to an application proxy; they are not Logfire ingest
  headers and must not be relayed upstream. Server `LOGFIRE_TOKEN` replaces any
  browser-supplied authorization.
- CORS is not authentication. Exact allowed origins reduce browser exposure,
  while the example remains development-only and loopback-bound.
- Vite server forwarding makes default browser URLs same-origin; the Express
  allow-list still requires direct allowed/disallowed Origin coverage.
- Both Vite configs read `packages/*/dist` at config/load time. A clean checkout
  must run the root package build before the examples.
- The examples directory is excluded from the root lint task and root
  `pnpm run test` filters packages only. Focused example builds/tests must be
  explicit final gates.

## Implementation Blueprint

### Tasks

```yaml
Task 1: Define and implement the basic proxy's safe public HTTP contract
  MODIFY examples/browser/src/proxy.ts:
    - Separate app creation/config parsing from listener startup so tests can run the actual Express app on disposable loopback ports.
    - Require HOST=127.0.0.1, default PORT=8989, default LOGFIRE_ALLOWED_ORIGINS=http://127.0.0.1:5173,http://127.0.0.1:4173, and the three literal standard upstream URLs; require non-empty LOGFIRE_TOKEN before listening.
    - Parse the configured origin list exactly as settled above, cap it at 16, and fail before listening on invalid/empty/duplicate/wildcard/pattern origins.
    - Allow no-Origin Vite/server clients; return exact JSON 403 without forwarding for a present disallowed Origin; echo only an exact allowed origin; emit neither wildcard ACAO nor Access-Control-Allow-Credentials.
    - Forward trace, metric, and replay bodies byte-for-byte. Upstream headers are only normalized server Authorization, incoming Content-Type, and optional Content-Encoding; strip client auth/cookie/CSRF/example/proxy/forwarded/hop-by-hop headers. Build replay child URL with an encoded path segment and URLSearchParams for seq.
    - Apply the existing 10 MiB limit to each forwarding route. Replace destructive overflow with bounded handling that completes exact JSON 413 for declared-length and chunked overflow, drains/safely terminates input, and keeps the server usable.
    - Catch every upstream fetch rejection inside the Express 4 boundary and complete exact JSON 502. Preserve completed upstream status/body and safe Content-Type only; strip Set-Cookie/hop-by-hop response headers and leak no token, URL, header, body, or exception detail in 403/413/502.
    - Keep /health and define GET /api/post as the basic fetch success route returning a deterministic JSON object used by the real UI smoke.
  ENABLES: CX-6, CX-7
  VERIFY:
    - COMMAND: vp run browser#test
    - EXPECTED: Basic proxy contract matrix passes with exact receipts, 403/413/502 deadlines, post-error health, and default 127.0.0.1 listener.

Task 2: Give the replay workbench proxy the identical security/error contract
  MODIFY examples/browser-rum-replay/src/proxy.ts:
    - Apply Task 1's configuration, forwarding, URL, origin, body-limit, Express rejection, response, and loopback contracts without changing catalog/inventory/checkout success payloads.
    - Keep PORT=8990 and default LOGFIRE_ALLOWED_ORIGINS=http://127.0.0.1:5174,http://127.0.0.1:4174; use the same HOST, upstream, token, parsing, and header rules.
  ENABLES: CX-6, CX-7
  VERIFY:
    - COMMAND: vp run browser-rum-replay#test
    - EXPECTED: The same full proxy matrix passes for this implementation, including all three forwarding routes and replay encoding.

Task 3: Add direct fake-upstream contract suites for both actual servers
  CREATE examples/browser/src/proxy.test.ts:
    - Start a local raw HTTP fake upstream and the exported basic Express app on 127.0.0.1 with a sentinel token and small injected body limit.
    - Assert exact trace/metric/replay paths, raw bytes, the three-header upstream allowlist, forbidden request-header absence, Authorization replacement/normalization, encoded session and seq, allowed preflight/response headers, preserved safe non-2xx upstream response, and stripped Set-Cookie/hop-by-hop response headers.
    - For trace, metric, and replay separately, assert exact allowed Origin/preflight ACAO plus absence of wildcard ACAO/Access-Control-Allow-Credentials; assert disallowed Origin and preflight return exact 403 JSON with zero receipt and no secret/URL detail.
    - For trace, metric, and replay separately, send both Content-Length and chunked bodies one byte over the limit; require exact completed 413 JSON/content type before a deadline, zero upstream receipt, no secret/URL detail, and successful /health afterward.
    - Close/refuse each upstream route; require exact completed 502 JSON/content type before a deadline, no unhandled rejection, no secret/URL/header/body detail, and successful /health afterward.
    - Assert every invalid LOGFIRE_ALLOWED_ORIGINS form and a missing token fails before listen; assert unset values select the literal defaults.
    - Assert the default listener address is exactly 127.0.0.1.
  CREATE examples/browser-rum-replay/src/proxy.test.ts:
    - Run the same contract against the replay workbench app; do not import or assume the other implementation in place of exercising this server.
  MODIFY both example package.json files:
    - Add a focused vp test task so these suites are not hidden by the root packages-only test filter.
  ENABLES: CX-6
  VERIFY:
    - COMMAND: vp run browser#test && vp run browser-rum-replay#test
    - EXPECTED: Both independently exercised public HTTP boundaries pass with no network access beyond loopback.

Task 4: Make browser defaults demonstrate the backend-proxy model
  MODIFY examples/browser/src/main.ts and examples/browser-rum-replay/src/main.ts:
    - Default trace, metric, replay, and demo API requests to relative /client-* and /api/* routes; retain only an explicit typed development override when useful.
    - Never add a Logfire token to browser configuration.
  MODIFY both vite.config.ts files:
    - Forward those relative development routes to each example's 127.0.0.1 proxy target while retaining the verified built replay/rrweb module loading; use LOGFIRE_PROXY_TARGET as the only server-side target override.
  MODIFY both vite-env.d.ts files:
    - Type VITE_LOGFIRE_PROXY_ORIGIN as an optional direct-loopback test override; production/default builds leave it unset and use relative same-origin routes.
  MODIFY both example package.json files:
    - Bind Vite dev/preview to 127.0.0.1 and change proxy loading to --env-file-if-exists=.env.
  ENABLES: CX-6, CX-7
  VERIFY:
    - COMMAND: vp run browser#build && vp run browser-rum-replay#build
    - EXPECTED: Both production examples build from the prebuilt workspace output and browser bundles contain no write token/default direct-ingest configuration.

Task 5: Contain and render every rejected example action
  MODIFY examples/browser/src/main.ts:
    - Check fetch response.ok, contain the span/action rejection, replace fetching with exact visible fetch-failed status, record/report the caught error safely, and allow retry.
  MODIFY examples/browser-rum-replay/src/main.ts:
    - Apply one consistent action boundary to catalog, XHR, and checkout; check fetch response.ok before JSON; render action-specific failure status/log text; settle on success or failure; preserve R5-safe console/example data; allow retry.
  MODIFY examples/browser/index.html and examples/browser-rum-replay/index.html only if needed:
    - Give the existing status surface an accessible live/status role without redesigning the examples.
  CREATE examples/browser-rum-replay/test-fixtures/proxy-example-safety/server.mjs:
    - Bind 127.0.0.1:8991 and accept only Origin http://127.0.0.1:5173 or :5174.
    - Provide POST /__r7/prepare/:mode/:action to hold the next selected action request, POST /__r7/release to complete it, and GET /__r7/status to record pending/completed exact action requests; modes are success, http, and network and actions are basic, catalog, inventory, and checkout.
    - In success mode release deterministic /api/post, catalog, inventory, and checkout payloads; accept trace/metric/replay requests locally with 202 and no credentials.
    - In HTTP mode release a deterministic 503 JSON action response; in network mode destroy only the held action response socket so browser fetch/XHR genuinely rejects.
    - Never contact the network or read LOGFIRE_TOKEN.
  ENABLES: CX-7
  VERIFY:
    - COMMAND: Run the exact three-mode CX-7 fixture and agent-browser matrix in Validation.
    - EXPECTED: Success paths settle once; in both HTTP and socket-rejection modes, fetch failed, catalog failed, inventory failed, and checkout failed each appear after their loading label, a second click settles, the control remains enabled/page responsive, and unhandled rejection count remains exactly zero in every isolated journey.

Task 6: Make setup and Python capability boundaries truthful
  CREATE examples/browser/.env.example:
    - Set HOST=127.0.0.1, PORT=8989, LOGFIRE_ALLOWED_ORIGINS=http://127.0.0.1:5173,http://127.0.0.1:4173, the three literal standard upstream URLs, and LOGFIRE_TOKEN=<your-logfire-write-token>; comments may explain optional overrides but may not contain a usable credential.
  MODIFY examples/browser-rum-replay/.env.example:
    - Use the same literal contract with PORT=8990 and LOGFIRE_ALLOWED_ORIGINS=http://127.0.0.1:5174,http://127.0.0.1:4174; remove internal port-3000 and seeded-token assumptions.
  MODIFY both example READMEs:
    - Start with pnpm run build at repository root, then copy .env.example optionally and run proxy/dev; explain --env-file-if-exists, same-origin Vite forwarding, loopback and exact-origin defaults, server-only token injection, 413/502 behavior, and development-only/non-production scope.
    - Explain how explicit overrides remain bounded and that direct browser tokens are not used.
  MODIFY docs/packages/browser.md:
    - Separate JavaScript telemetry/replay endpoint requirements from a clearly titled telemetry-only Python helper section.
    - State that forward_export_request_starlette/forward_export_request accept traces/logs/metrics and cannot forward /v1/replay.
    - State that replay needs a separately authenticated endpoint preserving the documented child path/query/body/headers; point to the JS development examples without providing a production deployment design.
  MODIFY packages/logfire-browser/README.md:
    - Keep the same proxy-first/direct-token-escape-hatch distinction and link the safe development examples/build prerequisite without weakening R3-R6 caveats.
  CREATE .changeset/browser-proxy-example-safety.md:
    - Add a browser patch note describing safe development proxy examples and the corrected telemetry-only Python/replay guidance; do not add private example packages.
  ENABLES: CX-6, CX-7
  VERIFY:
    - COMMAND: rg -n "telemetry-only|cannot forward.*replay|127\\.0\\.0\\.1|env-file-if-exists|pnpm run build|development-only" docs/packages/browser.md packages/logfire-browser/README.md examples/browser/README.md examples/browser-rum-replay/README.md examples/*/.env.example examples/*/package.json
    - EXPECTED: Every setup/boundary statement is present and no guidance claims Python helper replay support or browser-side token injection.

Task 7: Run integrated example, repository, and traceability gates
  VERIFY:
    - COMMAND: vp fmt --check examples/browser examples/browser-rum-replay packages/logfire-browser/README.md docs/packages/browser.md .changeset/browser-proxy-example-safety.md plans/029-browser-proxy-example-safety.md
    - EXPECTED: Formatting passes.
    - COMMAND: vp run browser#test && vp run browser-rum-replay#test && vp run browser#build && vp run browser-rum-replay#build
    - EXPECTED: Both independent proxy matrices and both example builds pass.
    - COMMAND: pnpm run check
    - EXPECTED: Full workspace build, check, typecheck, and package tests pass.
    - COMMAND: node --input-type=module -e "import { readFileSync } from 'node:fs'; const text = readFileSync('.changeset/browser-proxy-example-safety.md', 'utf8'); const match = /^---\\n([\\s\\S]*?)\\n---\\n\\n([\\s\\S]+)$/u.exec(text); if (match === null || match[1].trim() !== \"'@pydantic/logfire-browser': patch\" || !/proxy/iu.test(match[2]) || !/Python/iu.test(match[2]) || !/replay/iu.test(match[2])) process.exit(1)"
    - EXPECTED: Command exits 0 only when frontmatter is exactly @pydantic/logfire-browser: patch (therefore no replay/private-example selector) and the body names safe proxies plus corrected Python replay guidance.
    - COMMAND: Run every CX-6 and CX-7 procedure below and record exact receipts/status observations.
    - EXPECTED: Both parent scenarios receive DIRECTLY VERIFIED evidence; no proxy or UI implementation is represented by another implementation's test.
```

### Integration Points

```yaml
CONFIG:
  - examples/browser/.env.example — server-only upstream/token, HOST/PORT, exact allowed Vite dev and preview origins
  - examples/browser-rum-replay/.env.example — same contract on ports 8990/5174
  - both vite.config.ts files — relative browser routes to loopback development proxy

ROUTES/ENDPOINTS:
  - POST /client-traces — raw trace forwarding
  - POST /client-metrics — raw metric forwarding
  - POST /client-replay/:sessionId?seq=... — raw gzip replay forwarding with encoded child URL
  - GET /health — post-error liveness evidence
  - GET /api/post — deterministic basic example success journey
  - /api/catalog, /api/inventory, /api/checkout — replay example success journeys
  - test fixture 127.0.0.1:8991 — deterministic success, HTTP 503, and genuine socket-rejection journeys; never token injection

DOCUMENTATION:
  - docs/packages/browser.md — public proxy contract and Python telemetry-only boundary
  - packages/logfire-browser/README.md — published proxy-first guidance
  - both example READMEs — runnable development setup and failure behavior
```

## Validation

The executor must preserve exact command output and receipts in the Verification
Record. Internal helper assertions do not replace the public HTTP/browser
evidence in `CX-6` and `CX-7`.

```bash
# Baseline and build prerequisite
git status --short --branch
git show -s --format='%H %s' HEAD
node -v
pnpm --version
pnpm run build

# Both actual proxy implementations against their own loopback fake upstream
vp run browser#test
vp run browser-rum-replay#test

# Both shipped Vite examples
vp run browser#build
vp run browser-rum-replay#build

# Repository gates
vp fmt --check examples/browser examples/browser-rum-replay packages/logfire-browser/README.md docs/packages/browser.md .changeset/browser-proxy-example-safety.md plans/029-browser-proxy-example-safety.md
pnpm run check
```

For `CX-6`, the two focused suites must each record:

- actual listener address;
- allowed and rejected Origin/preflight responses;
- trace, metric, and replay upstream raw receipts, including exact URL,
  sentinel authorization, content type/encoding, and byte-identical body;
- replay session marker containing slash, space, delimiter, and non-ASCII data,
  plus a `seq` value containing a query delimiter, proving path/query encoding;
- declared-length and chunked one-byte-over-limit response status/body/timing,
  zero upstream receipt, and post-response health;
- rejected/unavailable trace, metric, and replay upstream status/body/timing,
  zero escaped rejection, and post-response health.

For `CX-7`, start the committed loopback fixture and both actual Vite examples in
three terminals after `pnpm run build`:

```bash
node examples/browser-rum-replay/test-fixtures/proxy-example-safety/server.mjs
VITE_LOGFIRE_PROXY_ORIGIN=http://127.0.0.1:8991 vp run browser#dev
VITE_LOGFIRE_PROXY_ORIGIN=http://127.0.0.1:8991 vp run browser-rum-replay#dev
```

Run every row below in a fresh named `agent-browser` session. The fixture must
hold the action response so the executor can observe the exact loading label
before `POST /__r7/release`. `success` runs once; `http` and `network` repeat the
prepare/click/loading/release/failure sequence twice in the same session to
prove retry.

| Action      | Page                     | Button                     | Loading              | Success                   | Failure            |
| ----------- | ------------------------ | -------------------------- | -------------------- | ------------------------- | ------------------ |
| `basic`     | `http://127.0.0.1:5173/` | `[data-action='fetch']`    | `fetching`           | `fetched 200`             | `fetch failed`     |
| `catalog`   | `http://127.0.0.1:5174/` | `[data-action='catalog']`  | `loading catalog`    | `catalog loaded for us`   | `catalog failed`   |
| `inventory` | `http://127.0.0.1:5174/` | `[data-action='xhr']`      | `checking inventory` | `inventory 42 at north-1` | `inventory failed` |
| `checkout`  | `http://127.0.0.1:5174/` | `[data-action='checkout']` | `checkout running`   | `checkout accepted`       | `checkout failed`  |

Use these exact commands for each `<mode>`/`<action>` row, substituting the
literal page/button/loading/result values from the table and a unique literal
session such as `r7-http-catalog`:

```bash
curl -fsS -X POST http://127.0.0.1:8991/__r7/prepare/<mode>/<action>
agent-browser --session <session> open <page>
agent-browser --session <session> eval "window.__r7Unhandled=[]; window.addEventListener('unhandledrejection', event => window.__r7Unhandled.push(String(event.reason)))"
agent-browser --session <session> click "<button>"
agent-browser --session <session> wait --fn "document.querySelector('#status')?.textContent === '<loading>'"
curl -fsS http://127.0.0.1:8991/__r7/status
curl -fsS -X POST http://127.0.0.1:8991/__r7/release
agent-browser --session <session> wait --fn "document.querySelector('#status')?.textContent === '<success-or-failure>'"
agent-browser --session <session> eval "JSON.stringify({disabled: document.querySelector('<button>')?.disabled, ping: document.body.dataset.r7Ping = 'responsive', status: document.querySelector('#status')?.textContent, unhandled: window.__r7Unhandled})"
agent-browser --session <session> close
```

For `http` and `network`, repeat `prepare` through the final wait/eval before
closing, using the same action and session. Each final eval must show
`disabled:false`, `ping:"responsive"`, the exact expected label, and an empty
`unhandled` array. Fixture status must record the expected method/path exactly.
This is the direct HTTP-non-2xx plus genuine browser network-rejection evidence;
a Vite-generated proxy error is not a substitute.

## Unknowns & Risks

- Express/body-parser implementation choice remains deliberately open, but its
  observable safety is not: real declared-length and chunked requests must
  complete before deadlines and the same listener must remain healthy.
- Requiring a non-empty token changes empty-env startup from unauthenticated
  forwarding to an explicit setup error. This is intentional for the standard
  external upstream default and must be documented/tested; sentinel credentials
  are sufficient for all local evidence.
- Vite development forwarding and direct cross-origin override are two paths.
  Both must resolve to the same `/client-*` proxy routes, while only the direct
  browser path exercises CORS.
- The current examples duplicate proxy logic. The executor may introduce a
  narrowly shared helper only if both actual apps still receive independent
  public-boundary tests and the helper does not become a published package.
- R9 must still combine these proxies with R1-R6 runtime behavior; R7 proves the
  proxy/UI boundary, not the final release as a whole.

**Confidence: 9/10** for one-pass implementation success.

## Execution Notes

- **Executed**: 2026-07-13 from source baseline
  `c628404ede63647fa0630e7f2f0daa7dc372cdb4`, preserving the pre-existing
  roadmap and child-PRP changes without staging or committing.
- **Bounded scope expansion**: added private shared helpers at
  `examples/browser/src/proxySupport.ts` and
  `examples/browser/src/proxyTestContract.ts` so the two example servers use
  one security contract while both actual Express apps still run the complete
  public HTTP suite independently.
- **Validation-only hook**: when the explicit loopback
  `VITE_LOGFIRE_PROXY_ORIGIN` override is set, each example installs the
  `__r7Unhandled` observer before interaction. Normal same-origin example
  builds do not install it.
- **Browser runner deviation**: the real-browser matrix used the Codex in-app
  browser controller required by the active browser-control skill instead of
  the equivalent `agent-browser` CLI commands. It exercised the same actual
  Vite pages, held fixture requests, success/HTTP/socket modes, exact status
  labels, same-page retries, enabled controls, and unhandled-rejection state.
- **Unresolved risks at execution handoff**: none identified within R7;
  independent verification is recorded below.

## Verification Record

- **Verified**: 2026-07-13 from source baseline
  `c628404ede63647fa0630e7f2f0daa7dc372cdb4`, preserving all pre-existing and
  executed tracked/untracked changes without staging or committing.
- **Independent Deep review**: one fresh-context read-only verifier completed
  consumer acceptance, PRP compliance, and engineering-quality passes
  sequentially and reported `READY` with no material findings.

| Scenario | Grade               | Direct evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Limitations                                                                                           |
| -------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `CX-6`   | `DIRECTLY VERIFIED` | Both actual Express applications independently passed 8/8 public HTTP cases against loopback fake upstreams: literal/invalid configuration, default `127.0.0.1` binding, trace/metric/replay byte and header receipts, encoded replay path/query, all-route CORS, declared/chunked `413`, rejected-upstream `502`, safe non-success responses, and post-error health. A separate public-proxy exercise confirmed genuine gzip binary/non-ASCII byte identity and decompression. | Uses sentinel credentials and loopback fake upstreams by design; no production deployment is claimed. |
| `CX-7`   | `DIRECTLY VERIFIED` | All 12 rows ran through the actual Vite pages and committed `127.0.0.1:8991` fixture. Success rows showed held loading then exact success. HTTP `503` and genuine socket rejection each settled twice per action in the same browser session. Every final observation showed the exact failure label, enabled control, responsive DOM, and `unhandled: []`; fixture status recorded the expected method/path.                                                                   | Local real-browser fixture only; no external service or credential is required or claimed.            |

### Compliance and Engineering Evidence

- All eight success criteria and seven blueprint tasks are implemented; the
  exclusions held. No SDK runtime/API, Python source, production proxy, replay
  schema, Next.js, or release-tooling behavior changed.
- The private shared proxy and test helpers are a bounded, recorded scope
  expansion. Both actual example applications retain independent
  public-boundary suites.
- The complete diff and surrounding code passed independent review for
  security, correctness, Express 4 rejection containment, resource handling,
  compatibility, maintainability, documentation truthfulness, and meaningful
  tests. No material issue was found.
- The committed replay receipt case labels simple bytes as gzip; the verifier
  closed that non-blocking evidence limitation with a separate genuine-gzip
  public-proxy exercise. Strengthening the committed test remains optional.

| Gate                                       | Result                                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| PRP structural validator                   | Passed with zero warnings                                                                      |
| `vp run browser#test`                      | 8/8 passed                                                                                     |
| `vp run browser-rum-replay#test`           | 8/8 passed                                                                                     |
| Both example production builds             | Passed                                                                                         |
| Complete real-browser `CX-7` matrix        | 12/12 rows passed, including same-session retries and zero unhandled rejections                |
| Focused formatting and Changeset validator | Passed; Changeset selects only `@pydantic/logfire-browser` patch and names proxy/Python/replay |
| `pnpm run check`                           | Passed package builds, formatting, lint, typecheck, and all package tests                      |
| `git diff --check`                         | Passed                                                                                         |

R7 now supplies R9 with the verified loopback development-proxy contract and
runnable proxy/UI environment. R8 remains the next ready child; R9 remains
blocked until R8 is verified.
