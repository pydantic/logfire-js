## Goal

Add an explicit manual pending-span API while keeping Browser automatic pending spans disabled.

Browser `configure()` must not install pending-span support automatically, either by default or behind a new config
option. Users who explicitly want Browser pending spans should call a shared `logfire.startPendingSpan()` helper.

`startPendingSpan()` creates and returns the real user span, emits exactly one synthetic `pending_span` placeholder for
that span immediately, and avoids duplicate placeholders when the runtime already has `PendingSpanProcessor` installed
(notably Node).

This PRP depends on:

- PRP 003: shared `PendingSpanProcessor` exists.
- PRP 004: `TailSamplingProcessor` supports deferred pending-span processing for accepted tail-sampled traces. This is
  relevant because manual pending placeholders should not independently drive tail-sampling decisions.

This PRP is intentionally scoped to:

- Shared `logfire.startPendingSpan()` API.
- Duplicate suppression between manual pending spans and automatic `PendingSpanProcessor` wiring.
- Tail-sampling behavior for manual pending placeholders.
- Browser pending-span product/default behavior decision.
- Browser tests proving `configure()` does not install automatic pending-span support.
- Browser documentation for the default-off behavior and manual helper.

Out of scope:

- Browser cleanup idempotency and lifecycle docs, covered by PRP 005.
- Cloudflare Worker lifecycle behavior, covered by PRP 005.
- Node process signal/error-handler refinement, covered by PRP 006.
- Adding a `pendingSpans` Browser config option.
- Adding an automatic Browser pending-span processor in default, head-sampled, or tail-sampled `configure()` paths.
- Adding a callback-style `pendingSpan()` helper. This PRP only adds `startPendingSpan()`.
- Changing Node's automatic pending-span default.

## Why

- Pending spans roughly double span volume for still-open spans and can change Browser telemetry cost/shape.
- Browser apps often produce many short-lived interaction/fetch spans, so enabling pending spans is a product and defaults decision, not just a lifecycle parity task.
- Browser instrumentation can run in user-facing, latency-sensitive environments; automatic pending spans may add export
  volume, network pressure, and backend ingestion cost without an explicit user choice.
- A manual helper gives users focused control without requiring custom OpenTelemetry provider wiring.
- The helper belongs in the shared `logfire` API so Browser, Node, and other runtimes expose one consistent manual
  tracing surface.
- Splitting this work keeps Browser cleanup/Cloudflare documentation low-risk and lets pending-span parity receive focused review.

## Success Criteria

- [x] `logfire.startPendingSpan()` is exported from the shared `logfire` package and re-exported by Browser.
- [x] `startPendingSpan()` creates the real span, emits exactly one synthetic `pending_span` placeholder immediately, and
      returns the real span for the caller to end.
- [x] Manual pending spans do not duplicate Node's automatic `PendingSpanProcessor` placeholders.
- [x] Manual pending placeholders preserve automatic pending-span wire-shape as closely as possible, including zero
      duration when SDK span timing is available.
- [x] Tail sampling does not accept or drop a trace based on a manual `pending_span` placeholder alone; the placeholder is
      exported only when the real trace is accepted.
- [x] Browser pending-span behavior is explicitly decided before implementation: no automatic pending spans in
      `configure()`, and no Browser `pendingSpans` config option in this PRP.
- [x] Browser `configure()` keeps default, head-sampled, and tail-sampled processor pipelines free of
      `PendingSpanProcessor`.
- [x] Browser tests assert that pending spans are not wired by `configure()` in both non-tail and tail-sampled paths.
- [x] Browser documentation accurately describes the default-off behavior, telemetry-volume rationale, and
      `startPendingSpan()` manual path.

## Clarifications

### Session 2026-05-27

- Q: Should Browser pending spans be enabled by default, exposed behind an opt-in option, or intentionally deferred for now?
  -> A: Do not enable automatic pending spans in Browser. Browser `configure()` should not install
  `PendingSpanProcessor` by default and should not add a new `pendingSpans` config option in this PRP.
- Q: How should users get Browser pending spans if they explicitly want them?
  -> A: Add `startPendingSpan()` to the shared `logfire` API. Browser re-exports the shared API, so Browser users can
  manually opt into pending placeholders without automatic processor wiring or a Browser-specific option.
- Q: Why not add an opt-in Browser `pendingSpans?: boolean` option?
  -> A: Even opt-in config makes the Browser SDK own a high-volume behavior across auto-instrumented fetch and
  interaction spans. Keep the public `configure()` surface conservative until there is stronger product evidence.
- Q: How should a shared helper avoid duplicate placeholders in Node, where `PendingSpanProcessor` is already installed?
  -> A: `startPendingSpan()` should start the real span with an internal OpenTelemetry context marker. The automatic
  `PendingSpanProcessor` reads that marker in `onStart()` and skips only that span, while `startPendingSpan()` emits the
  manual placeholder itself.
- Q: How should manual pending placeholders interact with tail sampling?
  -> A: A `pending_span` placeholder should be buffered with its trace but should not independently run the tail-sampling
  decision. It should export if the real trace is accepted and be dropped if the real trace is dropped.
- Q: How should `startPendingSpan()` emit the placeholder?
  -> A: Use the normal OpenTelemetry tracer path. Start the real span with an internal suppression context marker, then
  start and end a short `pending_span` child span immediately. Do not construct a synthetic `ReadableSpan` directly from
  the public API helper.
- Q: What should the public API surface be?
  -> A: Add only `startPendingSpan(msgTemplate, attributes?, options?)`, returning the real span. Do not add a
  callback-style `pendingSpan()` helper in this PRP.
- Q: What should duplicate suppression cover?
  -> A: Suppress only the real span created by `startPendingSpan()`. Child spans should still receive normal automatic
  pending spans in runtimes such as Node where `PendingSpanProcessor` is installed.
- Q: Should manual pending placeholders participate in tail-sampling callbacks?
  -> A: No. Buffer/replay them with the trace, but never run the tail callback on them. They export only if the real trace
  is accepted.
- Q: How should the suppression marker be scoped?
  -> A: Build a marked context locally and pass it as the third argument to `tracer.startSpan(...)` for the real span. Do
  not call `context.with(markedContext, ...)` for suppression; descendants should not inherit the marker.
- Q: What should `PendingSpanProcessor` read to detect suppression?
  -> A: Read the marker from the `parentContext` parameter passed to `onStart(span, parentContext)`. Do not read
  `context.active()` in the processor.
- Q: How should `startPendingSpan()` populate pending-parent and timing metadata?
  -> A: Treat SDK span fields as best-effort implementation details. If the real span is not recording, return it without
  a placeholder. If SDK timing data is unavailable, return it without a placeholder rather than emitting a shape that
  drifts from automatic pending spans. Extract the invalid-span-id sentinel into shared constants. When SDK timing is
  available, start and end the placeholder at the real span's start time so the placeholder is zero-duration.

## Context

### Key Files

- `packages/logfire-browser/src/index.ts` - Browser `configure()`, trace provider construction, sampling wiring, returned cleanup function.
- `packages/logfire-browser/src/LogfireSpanProcessor.ts` - Browser processor wrapper around batch/console processors.
- `packages/logfire-browser/src/index.test.ts` - Browser provider/config tests.
- `packages/logfire-browser/README.md` - Browser package documentation.
- `packages/logfire-api/src/index.ts` - shared manual tracing API and default export.
- `packages/logfire-api/src/index.test.ts` - shared API tests.
- `packages/logfire-api/src/constants.ts` - shared Logfire attribute keys and invalid-span-id sentinel.
- `packages/logfire-api/src/PendingSpanProcessor.ts` - shared pending-span processor.
- `packages/logfire-api/src/PendingSpanProcessor.test.ts` - pending processor tests.
- `packages/logfire-api/src/TailSamplingProcessor.ts` - shared tail-sampling processor with deferred pending support from PRP 004.
- `packages/logfire-api/src/sampling.test.ts` - tail-sampling tests.

### Existing Browser Processor Shape

- Browser currently builds one `LogfireSpanProcessor` wrapping a `BatchSpanProcessor`.
- If `options.sampling?.tail` is set, Browser wraps that processor in `new TailSamplingProcessor(spanProcessor, options.sampling.tail)`.
- `WebTracerProvider` receives a `spanProcessors` array, but Browser `configure()` must continue passing only the existing
  primary processor or tail wrapper. It should not add `PendingSpanProcessor`.

### Gotchas

- Do not add a `pendingSpans` option to `LogfireConfigOptions` in this PRP.
- Do not wire `new PendingSpanProcessor(primaryProcessor)` into Browser `configure()`.
- Do not pass `{ deferredProcessor: new PendingSpanProcessor(primaryProcessor) }` to Browser `TailSamplingProcessor`
  inside `configure()`.
- Implement `startPendingSpan()` in shared `logfire`, not Browser-only, so the manual API is consistent across runtimes.
- Do not use an exported span attribute to suppress automatic pending spans. Use an internal OpenTelemetry context key so
  suppression does not leak into exported telemetry.
- Build the suppression-marked context locally and pass it only to the real span's `tracer.startSpan(...)` call. Do not
  use `context.with(...)` for suppression.
- `PendingSpanProcessor` must read suppression from the `parentContext` argument passed to `onStart(...)`, not from
  `context.active()`.
- Suppression is single-span only. Do not suppress automatic pending spans for descendants of the manually-created real
  span.
- The synthetic manual placeholder is itself a span with `logfire.span_type = "pending_span"`. `PendingSpanProcessor`
  already skips non-real spans by span type; keep that behavior.
- `TailSamplingProcessor` must not call the tail callback for `pending_span` placeholders. Otherwise a manual placeholder
  could accept a trace before any real span meets the sampling criteria.
- `startPendingSpan()` should emit the placeholder through the normal OpenTelemetry tracer path by starting and ending a
  short child span, not by constructing a `ReadableSpan` directly.
- Start and end the placeholder at the real span's SDK `startTime` when available, producing zero-duration placeholders
  like `PendingSpanProcessor`. If the real span is non-recording or lacks SDK timing data, skip placeholder emission and
  return the real span.
- Compute formatted/scrubbed attributes once for the real span. Build the placeholder attributes by spreading those
  already-computed attributes and overriding only `logfire.pending_parent_id` and `logfire.span_type`.
- Both `startPendingSpan()` and `PendingSpanProcessor` must come from the same runtime copy of `logfire`. Duplicate
  package copies can silently break context-marker suppression.
- Browser spans are often short-lived. Documentation should set expectations about increased span volume and why the
  automatic path is intentionally disabled.

### API Shape

```ts
const span = logfire.startPendingSpan('Load dashboard', { route: '/dashboard' })
try {
  await loadDashboard()
} finally {
  span.end()
}
```

- Signature should mirror `startSpan()` as closely as practical:
  `startPendingSpan(msgTemplate: string, attributes?: Record<string, unknown>, options?: StartPendingSpanOptions): Span`.
- `StartPendingSpanOptions` should be `Omit<LogOptions, "log">`, supporting `level`, `parentSpan`, `tags`, and internal
  `_spanName` without exposing `log: true`.
- The returned span is the real user span with `logfire.span_type = "span"`.
- The synthetic placeholder span uses the same message/template attributes where possible, has
  `logfire.span_type = "pending_span"`, and records `logfire.pending_parent_id` for the real span's original parent.
- The helper should use the active tracer/provider like `startSpan()`, not a separate exporter path.
- The helper should not set the pending placeholder as active after returning. The caller receives the real span and owns
  when to end it.
- The helper may use an internal `ReadableSpan`-like cast to read `startTime` and `parentSpanContext`. Guard this cast:
  if the returned span is not recording or lacks `startTime`, skip placeholder emission.
- Passing the placeholder's `startTime` into `tracer.startSpan(name, { startTime, ... }, context)` and calling
  `placeholder.end(startTime)` only uses the public OTel `Tracer`/`Span` interfaces. No SDK cast is needed for emission
  itself; the SDK cast applies only when reading `startTime` / `parentSpanContext` off the real span.

## Implementation Blueprint

### Tasks

```yaml
Task 1: Resolve pending-span behavior decision
  RECORD answers under Clarifications before implementation:
    - no automatic Browser pending spans
    - no Browser `pendingSpans` config option in this PRP
    - manual path is shared `logfire.startPendingSpan()`

Task 2: Add shared manual pending-span API
  MODIFY packages/logfire-api/src/index.ts:
    - Add `StartPendingSpanOptions = Omit<LogOptions, "log">` type.
    - Add `startPendingSpan` to the package's named exports. Default-export updates for all runtimes happen in Task 5.
    - Factor shared span-formatting/start logic as needed so `startSpan()` and `startPendingSpan()` do not drift.
    - Compute formatted/scrubbed attributes once and reuse them for the real span and placeholder.
    - Build a local marked context and pass it as the third argument to `tracer.startSpan(...)` for the real span.
    - Do not use `context.with(...)` for the suppression marker.
    - If `realSpan.isRecording() === false`, return the real span without emitting a placeholder.
    - If SDK `startTime` is unavailable on the real span, return the real span without emitting a placeholder.
    - Emit one immediate `pending_span` child span through the normal OTel tracer path:
      - use the real span as parent
      - use the real span's SDK `startTime` as the placeholder start time
      - end the placeholder with the same start time to preserve zero-duration pending-span shape
      - derive attributes from the already-computed real-span attributes plus `logfire.pending_parent_id` and `logfire.span_type = "pending_span"`
    - Return the real span.
    - Do not add a callback-style `pendingSpan()` helper.

  MODIFY packages/logfire-api/src/constants.ts:
    - Export the invalid-span-id sentinel used when a real span has no parent.

  ADD packages/logfire-api/src/pendingSpanSuppression.ts:
    - Define an internal OpenTelemetry context key with `createContextKey(...)` for suppressing automatic pending-span
      emission.
    - Export `setPendingSpanSuppressed(context)` and `isPendingSpanSuppressed(context)` helpers used by
      `startPendingSpan()` and `PendingSpanProcessor`.
    - Do not re-export these helpers from the package's public entry point.

Task 3: Avoid duplicate automatic pending spans
  MODIFY packages/logfire-api/src/PendingSpanProcessor.ts:
    - Check the internal suppression marker from the `parentContext` argument in `onStart(span, parentContext)`.
    - Do not read `context.active()` inside `PendingSpanProcessor`.
    - If present, return without emitting an automatic placeholder for that real span.
    - Ensure suppression applies only to the span started with the marker, not descendants.
    - Preserve existing skip behavior for non-recording spans, unsampled spans, log spans, pending spans, and sample-rate attributes.
    - Use the shared invalid-span-id sentinel from constants instead of a local duplicate.

Task 4: Keep manual pending placeholders from driving tail sampling
  MODIFY packages/logfire-api/src/TailSamplingProcessor.ts:
    - Detect `span.attributes["logfire.span_type"] === "pending_span"` at the top of `checkSpan(...)`.
    - Buffer/replay pending placeholders with the trace like other spans.
    - Return `false` from `checkSpan(...)` for pending placeholders before calling the tail callback or flushing a buffer.
    - Preserve deferred pending processor behavior from PRP 004 for automatic pending spans.

Task 5: Keep default exports consistent across runtimes
  MODIFY packages/logfire-api/src/index.ts:
    - Add `startPendingSpan` to the default export type and object (named export is added in Task 2).

  MODIFY packages/logfire-browser/src/index.ts:
    - Import `startPendingSpan` from `logfire`.
    - Add `startPendingSpan` to the default export type and object.

  MODIFY packages/logfire-node/src/index.ts:
    - Import `startPendingSpan` from `logfire`.
    - Add `startPendingSpan` to the default export type and object.

  MODIFY packages/logfire-cf-workers/src/index.ts:
    - Import `startPendingSpan` from `logfire`.
    - Add `startPendingSpan` to the default export type and object.

Task 6: Keep Browser configure pending-span-free
  MODIFY packages/logfire-browser/src/index.ts:
    - Add a concise code comment at processor construction explaining pending spans are intentionally not wired in Browser because of volume/default concerns.
    - Preserve existing default, head-sampled, tail-sampled, and cleanup behavior.
    - Do not import `PendingSpanProcessor`.
    - Do not add a Browser config option.

Task 7: Shared API and processor tests
  MODIFY packages/logfire-api/src/index.test.ts and/or add focused integration tests:
    - Assert `startPendingSpan()` starts a real `span` and returns it.
    - Assert it emits exactly one `pending_span` placeholder immediately.
    - Assert the real span is started with a locally marked context and that no `context.with(...)` suppression path is used.
    - Assert the placeholder is emitted via the normal tracer path as a child span that starts and ends immediately at the real span's start time.
    - Assert no placeholder is emitted when the real span is non-recording.
    - Assert no placeholder is emitted when SDK timing data is unavailable.
    - Assert placeholder attributes include message/template/type metadata and pending-parent metadata.
    - Assert options such as `level`, `tags`, `parentSpan`, and `_spanName` follow `startSpan()` semantics where supported.
    - Assert no callback-style `pendingSpan()` helper is exported.

  MODIFY packages/logfire-api/src/PendingSpanProcessor.test.ts:
    - Assert `PendingSpanProcessor` skips automatic placeholder emission when the suppression marker is present.
    - Assert the normal automatic path still emits pending spans when the marker is absent.
    - Assert descendants of a `startPendingSpan()` span are not suppressed by the marker.

  MODIFY packages/logfire-api/src/sampling.test.ts:
    - Assert tail sampling does not accept a trace from a `pending_span` placeholder alone.
    - Assert the tail callback is not called for `pending_span` placeholders.
    - Assert accepted traces still export manual pending placeholders.
    - Assert dropped traces do not export manual pending placeholders.
    - Assert that when a user passes `parentSpan` to `startPendingSpan()` inside a tail-buffered trace, the real span's
      start is seen by the tail callback while the placeholder's start is not, and the placeholder is still buffered for
      replay if the trace is accepted.
    - Add a Node-shape integration test: wire `TailSamplingProcessor` with
      `deferredProcessor: new PendingSpanProcessor(primary)`, call `startPendingSpan()` inside the tail-buffered trace,
      drive the tail callback to accept on the real span's end, and assert that the primary exporter receives exactly
      one `pending_span` placeholder (the manual one). The deferred `PendingSpanProcessor` must not emit a second
      placeholder when `flushBuffer` replays the real span's start with its original suppression-marked
      `parentContext`. This is the regression guard for the three-link chain (buffered context reference survives
      replay -> marker survives on that context -> processor reads marker from `parentContext`).

Task 8: Browser tests
  MODIFY packages/logfire-browser/src/index.test.ts:
    - Prefer spying/mocking the `PendingSpanProcessor` constructor from `logfire` and assert it is never invoked across default, head-sampled, and tail-sampled `configure()` paths.
    - Assert default Browser processor wiring does not include `PendingSpanProcessor` if constructor spying is impractical.
    - Assert tail-sampled Browser processor wiring does not include a top-level `PendingSpanProcessor` if constructor spying is impractical.
    - Assert tail-sampled Browser processor wiring does not configure `TailSamplingProcessor` with a deferred pending processor if constructor spying is impractical.
    - Assert `startPendingSpan` is available from `@pydantic/logfire-browser` via the existing shared API re-export if test structure makes this practical.
    - Preserve existing resource/config/cleanup tests.

Task 9: Documentation
  MODIFY packages/logfire-api README/docs if present and appropriate:
    - Document `startPendingSpan()` as a manual escape hatch for long-running spans.
    - Explain that runtimes with automatic pending spans will not duplicate manual placeholders.
    - Note that suppression requires `startPendingSpan()` and `PendingSpanProcessor` to come from the same installed `logfire` copy.

  MODIFY packages/logfire-browser/README.md:
    - Document that Browser `configure()` does not emit automatic pending spans.
    - Explain the telemetry-volume and user-environment rationale.
    - Document `startPendingSpan()` as the manual Browser escape hatch.
    - Mention that manual pending placeholders still increase span volume for the spans where the helper is used.
    - Point users to Node support for automatic pending spans where applicable.

Task 10: Release metadata
  CREATE .changeset/<descriptive-name>.md:
    - Patch bump `logfire` for the new public API.
    - Patch bump runtime packages whose default exports gain `startPendingSpan` (`@pydantic/logfire-browser`, `@pydantic/logfire-node`, and `@pydantic/logfire-cf-workers`).
```

### Integration Points

```yaml
LOGFIRE_API:
  - startSpan
  - startPendingSpan
  - LogOptions / StartPendingSpanOptions
  - PendingSpanProcessor
  - TailSamplingProcessor
  - internal pending-span suppression context key

BROWSER:
  - LogfireConfigOptions
  - LogfireSpanProcessor
  - TailSamplingProcessor
  - PendingSpanProcessor
  - WebTracerProvider spanProcessors

DOCS:
  - packages/logfire-browser/README.md
```

## Validation

Run focused checks:

```bash
vp run logfire#test
vp run logfire#typecheck
vp run @pydantic/logfire-browser#test
vp run @pydantic/logfire-browser#typecheck
```

Run broader checks before PR:

```bash
pnpm run build
pnpm run format-check
```

### Required Test Coverage

- [x] `startPendingSpan()` emits one manual pending placeholder and returns the real span.
- [x] `startPendingSpan()` does not duplicate pending placeholders when `PendingSpanProcessor` is installed.
- [x] `startPendingSpan()` uses a local suppression-marked context, not `context.with(...)`.
- [x] `startPendingSpan()` emits zero-duration placeholders when SDK timing data is available.
- [x] `startPendingSpan()` skips placeholder emission for non-recording spans and spans without SDK timing data.
- [x] `PendingSpanProcessor` still emits automatic pending spans when no suppression marker is present.
- [x] `PendingSpanProcessor` reads suppression from the `parentContext` argument and does not suppress descendants.
- [x] Tail sampling ignores pending placeholders for sampling decisions.
- [x] Tail sampling does not call the user callback for pending placeholders.
- [x] Accepted tail-sampled traces export manual pending placeholders.
- [x] Dropped tail-sampled traces do not export manual pending placeholders.
- [x] Tail-sampled traces with a deferred `PendingSpanProcessor` emit exactly one `pending_span` placeholder when
      `startPendingSpan()` is used (no duplicate from the deferred processor on replay).
- [x] Browser default processor wiring does not include `PendingSpanProcessor`.
- [x] Browser tail-sampled processor wiring does not include top-level `PendingSpanProcessor`.
- [x] Browser tail-sampled processor wiring does not configure deferred pending processing.
- [x] Runtime default export objects include `startPendingSpan` wherever they mirror the shared `logfire` API.
- [x] README documents default-off behavior and `startPendingSpan()` manual usage.

## Unknowns & Risks

- `startPendingSpan()` needs SDK span fields (`startTime`, `parentSpanContext`) that are not on the public OTel `Span`
  interface. Guard these casts and skip placeholder emission when SDK timing data is unavailable.
- The suppression marker must stay internal and context-only. Do not use a telemetry attribute for suppression.
- Duplicate `logfire` copies in a dependency tree can break suppression because context keys are module-local.
- Tail-sampling changes must avoid regressing PRP 004 deferred automatic pending behavior.
- Browser tests may need to preserve class identity for `TailSamplingProcessor` and `PendingSpanProcessor` to assert processor absence without overfitting to private fields.
- If future product direction wants Browser automatic pending spans, revisit this PRP with explicit volume/cost analysis
  and likely an opt-in config design.

**Confidence: 9/10** for one-pass implementation success. The Browser side remains small, the shared manual helper
touches core API formatting and processor suppression, and the tail-sampled + deferred-`PendingSpanProcessor` chain is
now guarded by an explicit integration test that exercises the buffered-context replay path end-to-end.
