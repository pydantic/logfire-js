# Spike 01: Does plain sequential re-configure reproduce issue #167, and does disable-globals + tracer-refresh restore emissions?

## Status

CONCLUSIVE

## Question

Without any ESM/HMR re-import harness, does calling `configure()` a second time in the same Node process stop routing emissions to the new configuration, and does disabling the OTel API globals before re-registration plus refreshing `logfireApiConfig.tracer` afterwards restore deterministic routing — for both the reconfigure path and the `shutdown()` → `configure()` path?

## Why It Blocks Planning

- Determines the fix architecture (disable-then-re-register vs. an HMR-specific workaround or a stable-provider rearchitecture).
- Determines the validation strategy: if a plain in-process sequence reproduces the bug, `CX-N` scenarios can be exercised by deterministic vitest integration tests instead of an mcp-use/tsx HMR harness.

## Hypotheses and Decision Rule

- If the second `configure()`'s `additionalSpanProcessors` receive nothing while the first generation's keep receiving, the stuck-global-delegate mechanism is confirmed → plan the disable+refresh fix and vitest-based validation.
- If routing follows the latest generation without intervention, the failure needs the ESM re-import environment → redesign validation around an HMR harness and reassess root cause.
- If manual `trace/metrics/propagation/context/logs.disable()` before `configure()` plus `logfireApiConfig.tracer = trace.getTracer(scope)` after does not restore routing, reject the disable+refresh design.

## Minimal Experiment

- Environment and exact versions: Node v24.18.0, workspace at commit `a22a826`, freshly built dist (`pnpm run build`); `@opentelemetry/api` 1.9.1, `@opentelemetry/sdk-node` 0.219.0, `@opentelemetry/api-logs` 0.219.0.
- Setup: scratch dir with `node_modules` symlinks to `packages/logfire-node`, `packages/logfire-api` (as `logfire`), and the package's `@opentelemetry` deps, so the script exercises the published `dist` entry points with the same module instances the SDK loads.
- Action: four modes — `repro` (three sequential configures, each with a labeled pass-through span processor, probes emitted via `logfire.info()` between them), `fix` (same, with manual `disable()` on the five API globals before each re-configure and `logfireApiConfig.tracer` re-fetch after), `shutdown-reconfigure` (configure → shutdown → configure), `shutdown-fix` (same plus manual disable/refresh).
- Observation to capture: which generation's processor receives each probe (`logfire.span_type === 'log'` spans only).
- Safety and side-effect constraints: `sendToLogfire: false`, `metrics: false`; no network, no repository writes; scratchpad only.

## Evidence

- Commands run: `node spike.mjs repro`, `node spike.mjs fix`, `node spike.mjs shutdown-reconfigure`, `node spike.mjs shutdown-fix`.
- Relevant output summary:
  - `repro` → `["gen1:probe1","gen1:probe2","gen1:probe3","gen1:probe4"]` — generations 2 and 3 never receive anything; all emissions stay pinned to generation 1.
  - `fix` → `["gen1:probe1","gen2:probe2","gen2:probe3","gen3:probe4"]` — exact per-generation routing.
  - `shutdown-reconfigure` → `["gen1:probe1","gen1:probe2","gen1:probe3"]` — configure after shutdown is equally broken (globals never unregistered).
  - `shutdown-fix` → `["gen1:probe1","gen2:probe2","gen2:probe3"]` — remediation covers this path too.
- Artifacts or source locations: disposable script (removed after recording); mechanism cross-checked against installed sources — `@opentelemetry/api` `global-utils.js` (`registerGlobal` refuses duplicates, `allowOverride=false`), `trace.js` (`setGlobalTracerProvider` skips `setDelegate` when registration fails, `disable()` unregisters and replaces the proxy), `sdk-node` `sdk.js` (`shutdown()` never unregisters globals).

## Result

- Outcome: CONCLUSIVE
- Observed behavior: re-registration silently fails on every `configure()` after the first, pinning all emissions to the first SDK generation; once that generation's processors shut down (real exporters gate on shutdown), emissions go silent — matching issue #167's `2/4` observation without any HMR machinery. Disabling the five API globals (`trace`, `metrics`, `propagation`, `context`, `logs`) before re-configure and re-fetching `logfireApiConfig.tracer` after restores deterministic routing on both the reconfigure and shutdown→reconfigure paths.
- Decision: implement disable-owned-globals in the runtime teardown path plus tracer refresh after `sdk.start()`; validate with plain vitest integration tests through the public package entry points.
- Rejected alternatives: HMR-harness-based reproduction (unnecessary — plain sequence reproduces); awaiting the previous shutdown alone (does nothing — `NodeSDK.shutdown()` never unregisters globals); stable delegating provider a la `logfire-browser` (`NodeSDK` owns global registration and does not expose its providers, so this requires abandoning `NodeSDK` — larger rearchitecture than the issue warrants).
- Representativeness limits: the spike's pass-through processors do not gate on shutdown, so the "old generation keeps receiving until its real processors shut down" tail was observed structurally (new generation receives nothing) rather than as literal silence; real exporters (`BatchSpanProcessor`, console) drop after shutdown, which the issue transcript already evidences.

## Additional discovery (separate defect, same lifecycle surface)

`await logfire.shutdown()` with `sendToLogfire: false` and buffered spans hangs for the full 30s deadline and rejects with `forceFlush timed out` / `shutdown timed out`: `VoidTraceExporter.export()` (and `VoidMetricExporter.export()`) never invoke the OTel `resultCallback`, so `BatchSpanProcessor` flushes wait forever (`packages/logfire-node/src/VoidTraceExporter.ts:5`, `packages/logfire-node/src/VoidMetricExporter.ts:5`). This blocks any test that awaits `shutdown()` and burns a 30s hung flush on every re-configure in tokenless dev environments — the exact issue #167 environment. Experiment C/D worked around it with `shutdown({ flush: false, timeoutMillis: 300 })`.

## Planning Impact

- Fix tasks: disable owned globals in runtime teardown, refresh `logfireApiConfig.tracer` after `sdk.start()`, disable superseded instrumentations, fix both void exporters to invoke `resultCallback({ code: SUCCESS })`.
- `CX-N` scenarios can all be graded via deterministic vitest integration tests (no sleeps needed for routing assertions; routing is synchronous once `configure()` returns).
- Remaining uncertainty: mixed-ownership setups (application registered its own OTel globals before logfire) — disable-on-teardown adopts last-configure-wins semantics there; not spike-tested.

## Cleanup

- Disposable artifacts removed: scratch spike dir (script + symlinked node_modules) deleted after recording.
- Repository and external state checked: no repository writes; working tree clean apart from `plans/` artifacts.
