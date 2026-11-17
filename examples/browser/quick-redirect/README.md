# Quick redirect span delivery

Reproduces [#448](https://github.com/pydantic/logfire-js/issues/448) against the built browser SDK. No token or external collector is needed.

The page loads 250 small images. OpenTelemetry creates real `resourceFetch` spans, with extra attributes to model the large payload in the report. A processor records their IDs before export. The page navigates to another same-origin document 150 ms after `load` and collector warm-up finish; the destination also configures the SDK, with recovery explicitly enabled, so cross-document retries run there.

The Python standard-library collector uses a small TCP receive window, waits 300 ms before reading, then reads at most 4 KiB every 40 ms. This prevents localhost socket buffers from accepting the entire upload before navigation. It records spans only after receiving and parsing a complete body. The exporter timeout is 30 seconds so it does not cancel the control's slow upload. The test checks collector receipt against the original IDs, not browser request events. Session replay is disabled to isolate trace delivery. A startup request warms the CORS preflight cache before navigation.

Python 3 must be available for the collector, including in the normal browser acceptance suite. Run from the repository root:

```sh
vp install
vp run logfire#build
vp run @pydantic/logfire-browser#build
pnpm --filter @pydantic/logfire-session-replay exec playwright install chromium
pnpm --filter @pydantic/logfire-session-replay exec playwright test --config browser-tests/quick-redirect.config.ts
```

The `stay` control flushes the same spans without leaving the page. The `redirect` test asserts full delivery after navigation and recovery on the destination page. The `in-flight` case starts exporting before navigation, so recovery must also cover requests no longer in the batch processor's queue. Two more `stay` controls disable persistence or omit the option, and check that live exports do not write SDK storage. The `iframe` control starts another SDK instance in a same-origin iframe while the source upload is in flight; it must not duplicate resource spans. All cases must pass and leave no acknowledged requests in SDK storage. They also run in the normal browser acceptance suite; the command above starts only the servers needed for this regression. Evidence reports total, unique, and duplicate resource span counts. Navigation recovery is at least once: a lost acknowledgment can cause duplicates with the original IDs. All six scenarios require exactly one copy of each resource span in this controlled fixture. The newest keepalive chunk is excluded from recovery; other uploads can still be duplicated if their acknowledgment is lost. The collector evidence and Playwright trace are in `test-results/quick-redirect/`.

To inspect the example manually, start these commands in separate terminals from the repository root:

```sh
python3 examples/browser/quick-redirect/collector.py
```

```sh
pnpm exec vp dev --config examples/browser/quick-redirect/vite.config.ts
```

Open <http://127.0.0.1:4194/?run=manual&mode=redirect> or use `mode=stay` for the control. The collector applies the upload limit without browser emulation. Inspect <http://127.0.0.1:4195/receipts/manual> for server receipts. Use a new `run` value for each attempt. This example covers spans created after load; it does not test departures before load or promise recovery after tab closure.
