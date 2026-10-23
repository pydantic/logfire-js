# Frustration detector verification

Run `pnpm run check` to build packages and run repository checks.

## Unit and mutation tests

The pure detector has boundary tests and four generated properties with 500 fixed-seed
histories each: deadline classification, reset isolation, anchored rage episodes, and
re-entrant cancellation. DOM lifecycle tests exercise 100 start/click/mutation/stop
cycles, timer cleanup, and inert callbacks after shutdown.

Replay a generated failure using its printed seed, shrink path, and exact test name:

```sh
FRUSTRATION_SEED=20261022 FRUSTRATION_PATH='printed:path' \
  pnpm --filter @pydantic/logfire-browser test --run src/interactionFrustration.model.test.ts -t 'exact test name'
```

`FRUSTRATION_RUNS` changes the history count. Run `pnpm run test:frustration-mutations`
for the pure-detector mutation check, also run by CI with a 95% threshold. The DOM
and navigation adapters are outside that score; inspect survivors rather than
lowering the threshold to pass.

## Browser integration

```sh
pnpm --filter @pydantic/logfire-session-replay exec playwright test \
  --config browser-tests/frustration.config.ts
```

The suite owns its loopback fixture and existing replay-player servers. Chromium,
Firefox, and WebKit exercise the built public SDK, real OTLP exporter and recorder,
sampling, click-time correlation, shadow DOM, gestures, masking, idle rotation,
reload continuity, and rendered playback.

Clock-controlled cases intercept uploads. `frustration-http.pw.ts` instead verifies
real HTTP uploads and wall-clock response delays. Diagnostic writes use a separate
shadow root so they cannot count as application feedback. No case contacts a live
project or requires credentials.

Native BFCache checks require actual restoration, not a reload:

```sh
pnpm --filter @pydantic/logfire-session-replay exec playwright test \
  --config browser-tests/playwright.config.ts bfcache.pw.ts
```

They check pending-candidate reset, restored detection, recording identity,
contiguous chunk sequences, fresh snapshots, and masking. Unit tests separately
cover delayed writer handover, bounded timeout, and cancellation. Without Web Locks,
identity checks fail closed to a fresh recording; continuity is not guaranteed.

## Offline and retention soak

```sh
pnpm run test:frustration-soak
# Optional per-mode duration: 90 seconds to 10 minutes.
FRUSTRATION_SOAK_MS=600000 pnpm run test:frustration-soak
```

This manual Chromium suite pairs feature-off/on workloads with replay and automatic
instrumentation, 4x CPU throttling, and 8-second and 45-second outages. It requires
upload recovery, checkpoint snapshots after sequence gaps, masking, healthy-action
silence, no page exceptions, and bounded collected heap growth. A second case checks
70 isolated detector lifecycles with detached shadow targets. Attachments are saved
under `reports/frustration-soak/`. These bounded measurements do not establish
lossless delivery, leak freedom, or statistically significant CPU overhead.

## Known limits

The installed OpenTelemetry transport can exhaust Chromium keepalive quota when
successful response bodies use `no-store`
([upstream issue](https://github.com/open-telemetry/opentelemetry-js/issues/7001)).
The fixture uses `no-cache` for ingest responses; this is not an SDK fix. Reproduce
the separate transport problem with `FRUSTRATION_NO_STORE=1` and the HTTP test above.

Rapid combined-SDK reconfiguration also reproduced a shutdown timeout with
frustration enabled and disabled under the fixture's one-second export budget.
The isolated retention test does not cover that separate lifecycle problem.

Slow/dead clicks remain experimental broad-liveness heuristics. Calibrate them
against consented internal traffic before broader rollout. This change adds no
frustration markers or dedicated filters to the Logfire player.
