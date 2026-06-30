# Browser RUM Smoke Example

This example exercises the browser SDK from a real tab:

- `rum.webVitals` reports LCP, INP, CLS, FCP, and TTFB spans.
- `rum.webVitals.metrics` reports those Web Vitals as native histogram metrics.
- `rum.session.urlAttributes` strips query strings and fragments from emitted URL attributes.
- Optional `sessionReplay` records rrweb chunks through the local replay proxy.
- The page buttons create manual spans, fetch spans, an intentional layout shift, and a reported error.

Session replay is experimental while Logfire Platform replay ingest and playback
are still behind a feature flag. Use replay against a Platform build where that
feature is enabled.

Run the proxy in one terminal:

```bash
LOGFIRE_TOKEN='Bearer <write-token>' pnpm run proxy
```

The proxy forwards traces to `LOGFIRE_URL` or `http://localhost:3000/v1/traces`
by default. Metrics go to `LOGFIRE_METRICS_URL` or the same URL with
`/v1/traces` replaced by `/v1/metrics`. Replay chunks go to
`LOGFIRE_REPLAY_URL` or the same URL with `/v1/traces` replaced by
`/v1/replay`. For local platform development, use the project write token for
the project you are viewing, such as `logfire-write-token` for `logfire/logfire`.

Run the browser app in another terminal:

```bash
pnpm run dev
```

Set `VITE_LOGFIRE_REPLAY=true` for the browser app when you want to enable
session replay:

```bash
VITE_LOGFIRE_REPLAY=true pnpm run dev
```

Open the app URL with a query string, for example
`http://localhost:5173/?secret=should-not-appear#fragment`, then interact with
the buttons. In Logfire, check for spans named `web_vital.*` and confirm they
include `session.id`, `browser.session.id`, sanitized `url.full`, and
`url.path`. Also check for metrics named `logfire.browser.web_vital.*`; metric
data points should include low-cardinality attributes such as
`web_vital.name` and `web_vital.rating`, but not session ids, URL paths, or full
URLs. With replay enabled, check that replay uploads use the same browser
session id as those spans and that replay-active spans include
`logfire.session_replay.active` and `logfire.session_replay.mode`.

If replay fails to start locally with `ERR_BLOCKED_BY_CLIENT`, a browser privacy
extension may be blocking dev URLs that contain terms such as `session-replay`.
Test in a clean profile or disable the extension for this local app. This
example uses a neutral Vite virtual module named `lf-browser-recorder` so local
workspace testing avoids blocker-sensitive module URLs and resolves rrweb to its
browser ESM build.
