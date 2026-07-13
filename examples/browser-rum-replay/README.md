# Browser RUM + Session Replay Example

This example is an end-to-end browser telemetry workbench. It sends:

- browser traces and manual Logfire spans
- automatic document-load, fetch, XHR, and click/change spans
- RUM session attributes on browser spans
- Core Web Vitals spans and native histogram metrics
- rrweb session replay chunks through a local backend proxy
- replay custom events for console, fetch/XHR, navigation, and errors

Session replay is experimental while Logfire Platform replay ingest and playback
are still behind a feature flag. Use this example against a Platform build where
the replay feature is enabled, and keep production rollout behind your own
application flag.

## Run It

Build workspace packages from the repository root before starting either Vite
example:

```bash
pnpm run build
```

The included Express proxy is a development-only helper, not a production proxy
deployment. It binds to `127.0.0.1`, uses an exact bounded Vite dev and preview
origin allow-list, limits request bodies, and returns completed `413` or `502`
responses for oversized bodies or failed upstreams. It adds the Logfire write
token server-side; no credential is bundled into the browser.

Optionally create a local environment file and replace the token placeholder:

```bash
cd examples/browser-rum-replay
cp .env.example .env
```

The proxy script uses `--env-file-if-exists=.env`, so the file is optional.
Exported and inline variables also work. Start the proxy in one terminal:

```bash
cd examples/browser-rum-replay
pnpm run proxy
```

Environment variables:

- `LOGFIRE_URL`, defaulting to the public Logfire `/v1/traces` endpoint
- `LOGFIRE_METRICS_URL`, defaulting to the matching `/v1/metrics` endpoint
- `LOGFIRE_REPLAY_URL`, defaulting to the matching `/v1/replay` endpoint
- `LOGFIRE_TOKEN`, required and normalized to one `Bearer` authorization value
- `LOGFIRE_ALLOWED_ORIGINS`, defaulting to the exact Vite dev and preview origins
- `HOST`, fixed to `127.0.0.1`
- `PORT`, defaulting to `8990`

Start the browser app in another terminal:

```bash
cd examples/browser-rum-replay
pnpm run dev
```

Open:

```text
http://127.0.0.1:5174/?secret=should-not-appear#fragment
```

The browser uses relative `/api` and `/client-*` URLs. Vite forwards them to
`LOGFIRE_PROXY_TARGET`, which defaults to the loopback Express helper. This is
the authenticated backend-proxy model: the browser never receives a write
token. `VITE_LOGFIRE_PROXY_ORIGIN` is an explicit test-only escape hatch for
direct CORS checks and accepts only an `http://127.0.0.1:<port>` origin.

Use the buttons to generate fetch, XHR, manual spans, layout shifts, route
changes, console events, checkout spans, and reported errors.

## What To Look For

In traces/logs:

- service name `browser-rum-replay-example`
- spans named `documentLoad`, `click ...`, `HTTP GET`, and
  `browser replay ...`
- spans named `web_vital.lcp`, `web_vital.inp`, `web_vital.cls`,
  `web_vital.fcp`, and `web_vital.ttfb`
- `session.id` and `browser.session.id` on browser spans
- `logfire.session_replay.active` and `logfire.session_replay.mode` on spans
  while replay is active
- sanitized URL attributes such as `logfire.page.url.path=/orders/:id`

In metrics:

- namespace `logfire`
- metrics named `logfire.browser.web_vital.cls`,
  `logfire.browser.web_vital.fcp`, `logfire.browser.web_vital.inp`,
  `logfire.browser.web_vital.lcp`, and `logfire.browser.web_vital.ttfb`
- default metric attributes `web_vital.name` and `web_vital.rating`
- custom low-cardinality dimensions `app.route` and `app.view`

In replay:

- replay chunks uploaded to `/client-replay/:sessionId?seq=...`
- the replay session id matching `session.id` / `browser.session.id`
- masked input values from the form
- blocked content under `[data-logfire-block]`
- custom replay events for console, navigation, fetch/XHR, and reported errors

This demo deliberately opts into `captureConsole: true` so the console button
can demonstrate a replay console event. Console capture is off by default. The
example logs only a fixed demo marker and a route template; never put editable
identifiers, access tokens, secrets, or other sensitive values in captured
console arguments.

The replay defaults mask all rendered text and input values and remove query
strings and fragments from captured URLs. This example keeps those defaults;
`[data-logfire-block]` demonstrates omitting an entire subtree. Applications
that explicitly set `maskAllText: false` should use `maskTextSelector` for every
sensitive text region, and `redactUrlPatterns: []` deliberately restores raw
captured URLs.

The replay package ignores the telemetry upload URLs automatically, so trace,
metric, and replay proxy calls should not recursively appear as captured network
events.

## Troubleshooting Replay Startup

Browser privacy extensions or ad blockers can block local dev module URLs that
contain terms such as `session-replay`. If the console shows
`ERR_BLOCKED_BY_CLIENT` while loading replay, test in a clean profile or disable
the extension for this local app.

This example imports `lf-browser-recorder`, a neutral Vite virtual module,
instead of importing `@pydantic/logfire-session-replay` directly. The virtual
module avoids blocker-sensitive dev URLs and aliases rrweb to its browser ESM
build. If a local Vite integration fails with an error that `rrweb.cjs` does
not provide `record`, make sure rrweb resolves to `rrweb/dist/rrweb.js`.
