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

Build the workspace packages once from the repository root:

```bash
pnpm run build
```

The included Express proxy is a development-only helper, not a production proxy
deployment. It binds to `127.0.0.1`, accepts only the configured exact Vite dev
and preview origins, bounds request bodies, and converts oversized or failed
upstream requests into completed `413` or `502` responses. It adds the Logfire
write token server-side; the token is never bundled into browser code.

Optionally copy the complete environment template, then replace its token
placeholder:

```bash
cd examples/browser
cp .env.example .env
```

The proxy command loads `.env` when it exists and also works with exported or
inline environment variables. A non-empty `LOGFIRE_TOKEN` is required. The
default upstreams are the public Logfire trace, metric, and replay endpoints;
set the three explicit `LOGFIRE_*_URL` values for a local fake or development
upstream.

Run the proxy and browser app in separate terminals:

```bash
cd examples/browser
pnpm run proxy
```

```bash
cd examples/browser
pnpm run dev
```

Vite serves the page at `http://127.0.0.1:5173` and forwards the page's
same-origin `/api` and `/client-*` requests to the loopback Express helper.
This demonstrates the authenticated backend-proxy model without a browser
token or direct-ingest default. `LOGFIRE_PROXY_TARGET` can select a different
`http://127.0.0.1:<port>` development proxy. The browser-only
`VITE_LOGFIRE_PROXY_ORIGIN` override is reserved for explicit loopback CORS
testing and rejects non-loopback origins.

Set `VITE_LOGFIRE_REPLAY=true` for the browser app when you want to enable
session replay:

```bash
VITE_LOGFIRE_REPLAY=true pnpm run dev
```

Open the app URL with a query string, for example
`http://127.0.0.1:5173/?secret=should-not-appear#fragment`, then interact with
the buttons. In Logfire, check for spans named `web_vital.*` and confirm they
include `session.id`, `browser.session.id`, sanitized
`logfire.page.url.full`, and `logfire.page.url.path`. Also check for metrics
named `logfire.browser.web_vital.*`; metric
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
