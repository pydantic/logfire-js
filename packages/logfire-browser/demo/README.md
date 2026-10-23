# Browser interaction demo

From the repository root:

```sh
pnpm run build
pnpm run demo:frustration
```

Open <http://127.0.0.1:5190/shop.html>. The checkout uses the built public browser
SDK, automatic instrumentation, and the real replay recorder. No payment or order
is submitted. Try each scenario separately:

- **Add to bag:** a real, fast HTTP request; no frustration signal expected.
- **Get delivery estimate:** a real HTTP response delayed 3.4 seconds; slow-click signal.
- **Apply code:** no visible feedback; suspected dead-click signal after 7 seconds.
- **Place demo order:** three rapid clicks; one rage-click signal per episode.

**Review uploads** flushes replay and reads the local HTTP collector's receipts.
Trace export is batched and can take another second; click again to refresh.
**Watch local replay** plays the accepted gzip recording with rrweb. Text and
inputs stay masked; the playback dialog is blocked from being recorded itself.
Diagnostic updates live in a separate shadow root so they do not masquerade as
application feedback. Do not interact with unrelated controls while testing a
pending dead click.

The loopback collector holds up to 12 MB of decoded replay data and the newest
1,000 spans in memory. Restarting clears them. It is a development tool, not a
production ingest implementation. Its success is not evidence of cloud ingestion.

## Cloud verification

### Known Chromium transport limitation

The real demo exposed [OpenTelemetry issue #7001](https://github.com/open-telemetry/opentelemetry-js/issues/7001):
the installed 0.219 transport does not drain successful fetch response bodies.
With `Cache-Control: no-store`, Chromium can exhaust its keepalive quota and
stop delivering later telemetry even though the detector renders signals.
Firefox and WebKit passed the same test. Changing only the ingest response
header to `no-cache` made Chromium pass too.

The local receiver therefore uses `no-cache` for ingest success responses;
receipts still use `no-store`. This is a **demo-only workaround, not an SDK fix**.
Reproduce the failing condition without editing code:

```sh
FRUSTRATION_DEMO_NO_STORE=1 pnpm --filter @pydantic/logfire-session-replay exec playwright test \
  --config browser-tests/frustration.config.ts frustration-shop.pw.ts --project chromium
```

The upstream response-draining fix is listed in OpenTelemetry 0.222.0. Updating
the transport and rerunning the `no-store` case remains required before claiming
reliable Chromium delivery against such cloud endpoints.

### Connect a test project

Create a disposable frontend application in a Logfire test project and allow
this demo's origin. Use its **restricted frontend application token**, never a
normal write token. Start with both settings:

```sh
VITE_LOGFIRE_BASE_URL=https://logfire-us.pydantic.dev \
VITE_LOGFIRE_TOKEN='<frontend-application-token>' pnpm run demo:frustration
```

The token is intentionally public browser configuration; do not put a secret in
it or commit it. No proxy is needed. Cloud mode labels the destination and hides
local playback. Verify the three `browser.*_click` signals in the real project,
check their `logfire.session_replay.id`, then open the corresponding replay and
confirm the click location/time and masking. The demo cannot query cloud data
or assert that cloud playback works. Supply neither setting for local mode;
supplying only one is an error rather than a silent fallback.

## Repeatable real-clock check

```sh
pnpm --filter @pydantic/logfire-session-replay exec playwright test \
  --config browser-tests/frustration.config.ts frustration-shop.pw.ts
```

This runs the complete checkout in Chromium, Firefox, and WebKit with real HTTP
uploads and wall-clock delays: no request interception or fake timers. Stop a
manually started demo first; tests own their servers and stop them afterward.
