# Frustration detector verification

Build packages first with `pnpm run build`. Run the normal checks with
`pnpm run check`; generated histories are part of the browser package's unit tests.

## Generated histories

`interactionFrustration.model.test.ts` runs four properties, each with 500 histories
and a fixed seed. A separate deadline-ticket model checks signals and deadlines
after each action; other properties check reset isolation, rage deduplication,
frozen click context, and re-entrant resets. Histories include exact time boundaries,
target changes, responses, resets, pending-only cancellation, and populations exceeding the pending limit.

Failures print a seed, shrink path, and minimized counterexample. Replay one
property with its printed seed/path and exact test name:

```sh
FRUSTRATION_SEED=20261022 FRUSTRATION_PATH='printed:path' \
  pnpm --filter @pydantic/logfire-browser test --run src/interactionFrustration.model.test.ts -t 'exact test name'
```

Change `FRUSTRATION_SEED` or increase `FRUSTRATION_RUNS` for additional searches;
add `--testTimeout 30000` to the test command for larger runs.
The lifecycle suite also runs 100 start/click/mutation/stop cycles and asserts the
timer baseline and inert captured callbacks after each stop. This is not a heap
retention benchmark or a proof of every browser event ordering.

## Mutation checks

Run `pnpm run test:frustration-mutations`. Stryker mutates the pure detector in an
isolated sandbox, running the real Vite+ unit/property tests through its command
runner. CI runs this check and uploads its JSON report on failure. A score below
95 fails the command. String-literal mutations are excluded; exact event names
are asserted by the export tests instead. The shell and navigation adapter are
not included in this mutation score.

The 2026-10-22 run killed 125 of 128 tested mutations (97.66%), with no timeouts
or errors. Three equivalent survivors remain: two option-normalization guards
already constrained by earlier branches, and decrementing instead of incrementing
the generation equality token. Five excluded string literals are outside that
denominator. Re-entrant pending cancellation is covered explicitly, including
cancellation during an expiry callback without advancing the rage episode.

Do not treat a high score as proof. Inspect newly surviving mutants rather than
lowering the threshold or excluding them merely to make CI green.

## Recorder and playback integration

```sh
pnpm --filter @pydantic/logfire-session-replay exec playwright test \
  --config browser-tests/frustration.config.ts
```

This focused suite starts and stops its own local demo and playback servers. It
runs Chromium, Firefox, and WebKit against built public SDKs, the real recorder,
automatic instrumentation, gzip replay uploads, the OTLP exporter, and rrweb
playback. It checks recording IDs, backdated click timestamps against recorded
click events, idle rotation, reload continuity, unique chunk sequences, masked
text/input canaries, and rendered playback DOM. The clock-controlled cases intercept
successful uploads. `frustration-shop.pw.ts` instead uses wall-clock delays and the
bounded local HTTP collector, without intercepting requests. Neither contacts a live project.

The native interaction corpus includes immediate DOM feedback, delayed feedback,
unresponsive controls, repeated Enter activations, and new pointer/keyboard/wheel
gestures. A new gesture cancels ambiguous response observations without erasing
rage history. Programmatic focus still counts as broad feedback. This is a synthetic calibration corpus,
not a measured customer false-positive rate.

## Native BFCache

```sh
pnpm --filter @pydantic/logfire-session-replay exec playwright test \
  --config browser-tests/playwright.config.ts bfcache.pw.ts
```

The combined test requires `pageshow.persisted` and the original document identity:
a reload cannot satisfy it. It navigates from a pending click without an intervening
gesture, restores the page, then verifies new detection, unchanged replay correlation,
unique contiguous chunk sequences, fresh full snapshots, and masking. The existing
recorder-only case also checks rendered playback of the restored snapshot.
Both interactive demos must also keep detecting after a native Back restoration;
their lifecycle is managed by the SDK rather than permanent demo-level teardown.

Incoming `pageshow` can race outgoing `pagehide`. With Web Locks,
the recorder waits for the outgoing writer before reading ownership/sequence.
The deterministic coordination suite checks delayed release, one bounded timeout
with a fresh identity, and stop/pagehide cancellation before or during acquisition.
Without Web Locks, ownership/sequence checks still fail closed to a new identity;
continuity across every browser lifecycle ordering is not guaranteed.

## Offline and retention soak

```sh
pnpm run test:frustration-soak
# Optional per-mode duration, 90 seconds to 10 minutes:
FRUSTRATION_SOAK_MS=600000 pnpm run test:frustration-soak
```

This slower Chromium-only suite is manual, not part of the default browser job.
It runs feature-off/on modes with the same real recorder and auto-instrumentation,
4x CPU throttling, native healthy clicks, continuous DOM mutations, and actual
8-second and 45-second network outages. The latter exceeds the recorder's retry
budget. Assertions require resumed uploads, unique sequences, a full-snapshot
checkpoint after each missing sequence range, masking, no page exceptions,
healthy-action silence, and bounded collected heap growth. It does not promise
lossless trace or replay delivery during an outage.

A second case isolates the detector from recorder/automatic instrumentation and
runs 70 configure/click/stop cycles with newly created open shadow roots. It removes
the clicked hosts, forces garbage collection, and bounds late-run heap, DOM-node,
and listener growth. These are bounded observations, not a proof of leak freedom.
The report includes Chromium TaskDuration, but one ordered
off/on pair with differing click counts is informational, not a CPU regression gate.
Measurements and chunk receipts are attached under `reports/frustration-soak/`.

The collector's documented `no-cache` workaround is still in effect. This soak
does not validate the separate OpenTelemetry `no-store` response-body bug; see
the demo README for its reproducer.

Rapid reconfiguration of the combined SDK also reproduced a shutdown timeout with
frustration both enabled and disabled, using the fixture's one-second export budget.
The isolated retention test does not cover that combined lifecycle problem. Keep
the dependency/transport follow-up separate rather than silently absorbing it here.

### Measured development results

On 2026-10-22, Node 24.14.1 and Chromium 151 on an Apple M5 Pro (Darwin arm64):
the paired three-minute modes both passed. Feature-off/on handled all 353/351
native healthy clicks, recovered from both outages, and ended with 23 listeners
and 324 DOM nodes in each mode. Collected-heap growth was 698,644/731,844 bytes.
TaskDuration increased by 9.08/9.95 seconds; do not interpret that single pair as
a statistically established overhead percentage.

The isolated 70-cycle detached-shadow-target test also passed: samples at cycles
10/40/70 had 23/23/23 listeners, 318/313/318 nodes, and 7,263,436/7,295,372/7,328,152
collected heap bytes. These results establish this bounded fixture, not arbitrary
customer application behavior or long-term leak freedom.

## Real backend check and rollout limits

Repeat the workflow in the demo README against an authorized test project. The
2026-10-22 manual check used a disposable development instance with a restricted
frontend application token. All three engines produced the three expected signals;
fresh queries checked exact replay IDs and timestamp bounds, and fetched replay
chunks contained full snapshots without the input canary. Logfire's player rendered
the masked recording and advanced after seeking. This is development-instance
evidence, not hosted deployment or customer-traffic validation.

When checking gestures, distinguish native input from
[Playwright's automatic scrolling before clicks](https://playwright.dev/docs/input#scrolling).
When a control is below the viewport, automatic scrolling can precede
`pointerdown` and classify a pending response. Use a native wheel gesture to test
user scrolling and cancellation without weakening the signal assertions. Programmatic
scrolling remains broad response evidence, just like programmatic focus; this
does not establish causal success or a customer false-positive rate.

Before broad rollout, calibrate against consented internal replay traffic and
review legitimate repeat controls and application-specific feedback. Suspected
dead-click reporting remains experimental. This work does not add frustration
markers or dedicated filters to the Logfire player, nor fix the separate installed
OpenTelemetry transport dependency.
