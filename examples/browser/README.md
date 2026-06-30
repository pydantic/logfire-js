# Browser RUM Smoke Example

This example exercises the browser SDK from a real tab:

- `rum.webVitals` reports LCP, INP, CLS, FCP, and TTFB spans.
- `rum.webVitals.metrics` reports those Web Vitals as native histogram metrics.
- `rum.session.urlAttributes` strips query strings and fragments from emitted URL attributes.
- Optional `sessionReplay` records rrweb chunks through the local replay proxy.
- The page buttons create manual spans, fetch spans, an intentional layout shift, and a reported error.

Run the proxy in one terminal:

```bash
LOGFIRE_TOKEN='Bearer <write-token>' pnpm run proxy
```

The proxy forwards traces to `LOGFIRE_URL` or `http://localhost:4318/v1/traces`
by default. Metrics go to `LOGFIRE_METRICS_URL` or the same URL with
`/v1/traces` replaced by `/v1/metrics`. Replay chunks go to
`LOGFIRE_REPLAY_URL` or the same URL with `/v1/traces` replaced by
`/v1/replay`.

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
`web_vital.name`, `web_vital.rating`, and sanitized `url.path`, but not session
ids or full URLs. With replay enabled, check that replay uploads use the same
browser session id as those spans and that replay-active spans include
`logfire.session_replay.active` and `logfire.session_replay.mode`.
