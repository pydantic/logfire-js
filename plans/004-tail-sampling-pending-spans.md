## Goal

Make pending spans work correctly when tail sampling is enabled.

This PRP depends on:

- PRP 003: shared `PendingSpanProcessor` exists and Node emits pending spans for non-tail-sampled traces.

This PRP is intentionally scoped to:

- `TailSamplingProcessor` changes needed to defer pending-span emission
- Node wiring when tail sampling is enabled
- tests proving dropped traces do not emit pending spans
- Python-parity behavior for spans that already ended before tail sampling accepts a trace
- accepted-trace fast-path behavior for spans that start after the trace has already been accepted
- typed buffer cleanup that separates buffered start and end events to reduce replay casting mistakes

Out of scope:

- Node lifecycle flush/shutdown correctness, covered by PRP 002
- core pending-span implementation, covered by PRP 003
- Browser and Cloudflare runtime parity, covered by PRP 005
- generic user-configurable deferred span processors; this PRP only needs Logfire's pending-span processor
- rewriting JS tail sampling to Python's architecture where the wrapped processor receives `onStart` immediately

## Why

- Pending spans are emitted at span start, but tail sampling decides later whether a trace should be exported.
- If pending spans are emitted immediately, dropped traces can still leave visible pending artifacts.
- Python handles this by passing a pending-span processor as a deferred processor to tail sampling.
- This is the riskiest pending-span integration and should be reviewed separately from the core processor.

## Success Criteria

- [ ] Tail-sampled accepted traces emit pending spans for eligible spans that are still recording when the trace is accepted.
- [ ] Spans that start after a trace has already been accepted emit pending spans immediately via the accepted-trace fast path.
- [ ] Spans that start after a trace was accepted from either `onStart` or `onEnd` emit pending spans immediately while the accepted root is still open.
- [ ] Tail-sampled dropped traces emit no pending spans.
- [ ] Pending spans are emitted before or alongside the accepted final span export for still-open spans so long-running accepted traces become visible.
- [ ] Spans that already ended before tail sampling accepts the trace do not need synthetic pending spans, matching Python SDK behavior.
- [ ] Existing tail-sampling behavior for normal spans remains unchanged.
- [ ] `forceFlush()` and `shutdown()` still flush/shutdown each owned processor exactly once.
- [ ] Node installs pending-span support when tail sampling is enabled.
- [ ] Tests cover accepted, dropped, and shutdown/flush behavior.

## Clarifications

### Session 2026-05-27

- Q: Should JS mirror Python's deferred pending-span architecture? -> A: Yes for accepted-trace replay and already-ended span behavior. Use a deferred `PendingSpanProcessor` in the tail-sampling path so dropped traces never emit pending spans.
- Q: Should tail sampling create pending spans for accepted spans that already ended before the sampling decision? -> A: No. Match Python: `PendingSpanProcessor` skips spans that are no longer recording, so only still-recording eligible spans get pending placeholders.
- Q: Should this PRP add Python's generic `tail_sampling_defer_on_start` user-processor mechanism? -> A: No. Keep this scoped to Logfire pending spans only.
- Q: Should JS call the deferred pending processor for spans that start after a trace has already been accepted? -> A: Yes. The `FLUSHED`/accepted fast path must pass through the deferred processor too, otherwise long-running accepted traces lose pending placeholders for later child spans.
- Q: Should JS copy Python's behavior for late children of traces already discarded at root end? -> A: No. Treat this as a deliberate JS divergence: only accepted traces invoke the deferred pending processor. Unknown or dropped no-buffer traces should continue through the wrapped processor without creating pending spans.
- Q: Which implementation option should PRP 004 use for the JS/Python architecture nuance? -> A: Option 2. Keep JS's existing wrapped-processor replay behavior, but clean up the buffer model with typed start/end collections so deferred replay cannot accidentally cast an ended span into `onStart()`.
- Q: Should JS keep accepted-trace state forever to cover detached children that start after root end? -> A: No. Delete accepted sentinels at root end to keep memory bounded. Detached children that start after the accepted root has ended will not get pending placeholders; this is an intentional trade-off.

## Context

### Key Files

- `packages/logfire-api/src/TailSamplingProcessor.ts` - buffers spans and decides whether to export traces.
- `packages/logfire-api/src/sampling.test.ts` - existing tests for tail sampling behavior.
- `packages/logfire-api/src/PendingSpanProcessor.ts` - created by PRP 003.
- `packages/logfire-node/src/sdk.ts` - Node tail sampling configuration and span processor construction.
- `packages/logfire-node/src/__test__/sdk.test.ts` - Node processor wiring tests.

### Python Reference

- `../logfire/logfire/sampling/_tail_sampling.py` - accepts a `deferred_processor` and delegates accepted traces so pending spans are emitted only when the trace survives sampling.
- `../logfire/logfire/_internal/config.py` - when tail sampling is active, passes `PendingSpanProcessor(...)` as the deferred processor instead of adding it directly to the main processor list.
- `../logfire/logfire/_internal/tracer.py` - `PendingSpanProcessor.on_start()` skips spans that are no longer recording; this means accepted traces may omit pending placeholders for spans that finished before tail sampling accepted the trace.
- `../logfire/tests/test_tail_sampling.py` - documents the duration-threshold behavior where a still-open parent gets a pending span but an already-ended child does not.

### Gotchas

- Emitting pending spans before tail-sampling acceptance is incorrect.
- Replaying `onStart()` calls into `PendingSpanProcessor` is acceptable because its `onEnd()` is a no-op.
- After a trace is accepted, later `onStart()` calls for the same trace must call both the wrapped processor and the deferred pending processor immediately. Calling only the wrapped processor in the accepted fast path silently drops pending placeholders for later child spans.
- Do not call the deferred pending processor for traces whose buffer is absent because the trace was dropped or was never tracked. This intentionally differs from Python's generic `buffer is None` behavior because PYD-3530's JS goal is no pending spans for dropped traces.
- Do not double-call `forceFlush()` or `shutdown()` on the primary processor when the pending processor wraps it.
- Python wraps deferred lifecycle calls in `suppress_instrumentation()` to prevent recursive span creation during shutdown/flush. JS `PendingSpanProcessor.forceFlush()` and `.shutdown()` are no-ops today; if that changes, add equivalent recursion protection before invoking deferred lifecycle work.
- Trace acceptance may happen after some child spans already ended. Match Python and keep `PendingSpanProcessor`'s `isRecording()` guard: already-ended spans are exported as normal spans when accepted, but they do not need pending placeholders.
- Current JS tail sampling buffers wrapped `onStart()` calls too, unlike Python which calls the main processor's `on_start` immediately. Avoid rewriting that architecture unless necessary for correctness; this PRP only requires adding a deferred pending-span path without regressing existing tail-sampling behavior. This also means wrapped processors may receive replayed `onStart()` for spans whose `end()` already fired; that is pre-existing JS behavior.
- The existing `FLUSHED` sentinel can otherwise grow without bound for accepted traces. When an accepted trace's root span ends, clear the sentinel after pass-through so post-acceptance routing remains available while the root is open but does not leak trace IDs forever.
- Sentinel deletion at root end means children that start in this trace after the root's `onEnd` will not receive pending placeholders. This is an intentional memory-bounding trade-off; the alternative of retaining known-accepted trace IDs indefinitely is rejected for this PRP.
- Preserve the existing public `TailSamplingProcessor` constructor shape if possible, or add an options object in a backward-compatible way.

## Implementation Blueprint

### Data Models

Prefer a backward-compatible options shape:

```ts
export interface TailSamplingProcessorOptions {
  deferredProcessor?: SpanProcessor
}
```

If the current constructor already takes positional arguments, add the options parameter at the end:

```ts
new TailSamplingProcessor(wrapped, sampler, options?)
```

Use typed buffered event collections instead of a loose `event` union when touching the buffer shape:

```ts
interface BufferedStart {
  context: Context
  span: Span
}

interface TraceBuffer {
  ended: ReadableSpan[]
  started: BufferedStart[]
  startTime: HrTime
}
```

Keep `started` for the existing wrapped-processor replay behavior as well as deferred replay. Do not gate it solely on `deferredProcessor` unless the wrapped processor architecture is intentionally changed in a later PR.

### Tasks

```yaml
Task 0: Clean up buffer typing without changing wrapped-processor semantics
  MODIFY packages/logfire-api/src/TailSamplingProcessor.ts:
    - Replace the loose `BufferedSpan` event union with typed `started` and `ended` collections.
    - Preserve current JS behavior where the wrapped processor's `onStart` is buffered and replayed after acceptance.
    - Use `started` entries only for `onStart` replay into wrapped/deferred processors.
    - Use `ended` entries only for `onEnd` replay into wrapped/deferred processors.
    - Do not change the main processor to Python-style immediate `onStart` in this PRP.

Task 1: Extend TailSamplingProcessor with deferred processing
  MODIFY packages/logfire-api/src/TailSamplingProcessor.ts:
    - Accept an optional deferred processor.
    - Store enough accepted-span start information to replay `onStart(span, parentContext)` into the deferred processor when a trace is accepted.
    - Invoke the deferred processor only for traces that are accepted.
    - In the accepted/`FLUSHED` `onStart` fast path, call `deferredProcessor.onStart(span, parentContext)` immediately after/beside `wrapped.onStart(span, parentContext)`.
    - In the accepted/`FLUSHED` `onEnd` fast path, call `deferredProcessor.onEnd(span)` immediately after/beside `wrapped.onEnd(span)`. This is a no-op for `PendingSpanProcessor`, but keeps deferred lifecycle semantics coherent.
    - Do not invoke the deferred processor for dropped traces.
    - Do not invoke the deferred processor in the no-entry/non-root path used for traces that were dropped, started before this processor was active, or otherwise are not known accepted.
    - Preserve Python parity: if the deferred processor skips already-ended spans because `span.isRecording()` is false, do not work around that in tail sampling.
    - Keep normal wrapped processor export order stable.
    - Ensure deferred processing does not create duplicate final span exports.
    - When the accepted/`FLUSHED` path sees the root span end, delete the trace entry after forwarding so accepted trace IDs do not accumulate forever.
    - Detect root in the accepted/`FLUSHED` `onEnd` branch with `!span.parentSpanContext`, matching the existing buffered-root check.
    - Delete the accepted/`FLUSHED` sentinel only after both wrapped and deferred `onEnd` forwarding have completed, so any in-flight forwarding logic still observes the accepted state.
    - Keep replay typing safe through the typed buffer model: only `started` entries may be passed to `deferredProcessor.onStart`; `ended` entries must only go to `deferredProcessor.onEnd`.

Task 2: Flush/shutdown semantics
  MODIFY packages/logfire-api/src/TailSamplingProcessor.ts:
    - Preserve existing wrapped processor flush/shutdown behavior.
    - Include the deferred processor only if it owns independent state.
    - If the deferred processor wraps the same primary processor used by `wrapped`, avoid double flush/shutdown.
    - Do not add deferred lifecycle calls that can recurse through instrumentation unless an equivalent to Python's `suppress_instrumentation()` exists.
  MODIFY packages/logfire-api/src/sampling.test.ts:
    - Assert `forceFlush()` and `shutdown()` do not double-call shared processors.

Task 3: Add tail-sampling tests
  MODIFY packages/logfire-api/src/sampling.test.ts:
    - Accepted trace emits pending spans for still-recording eligible spans.
    - Trace accepted at child A's start; child B starts later while the root is still open; child B emits a pending span via the accepted fast path.
    - Trace accepted at child A's end; child B starts later while the root is still open; child B emits a pending span via the accepted fast path.
    - Dropped trace emits no pending spans.
    - Dropped trace with a late child after root end does not emit a pending span, documenting the intentional JS divergence from Python's generic no-buffer path.
    - Mixed trace with multiple spans emits pending spans only for eligible spans that are still recording at acceptance time.
    - Accepted trace with an already-ended child documents Python parity: the child exports normally after acceptance but does not require a pending placeholder.
    - Log spans and skipped spans remain skipped through the deferred path.
    - Deferred-path spans must have `TraceFlags.SAMPLED` set so missing pending spans do not pass for the wrong reason.
    - At least one deferred replay test must use a realistic recording lifecycle rather than a mock whose `isRecording()` always returns `true`.
    - Accepted root end clears the `FLUSHED` sentinel while still exporting real spans correctly.
    - Existing tail-sampling tests still pass unchanged.

Task 4: Wire Node tail-sampled path
  MODIFY packages/logfire-node/src/sdk.ts:
    - When tail sampling is enabled, create `PendingSpanProcessor` as the deferred processor for `TailSamplingProcessor`.
    - Remove the PRP 003 guard that disabled pending spans under tail sampling.
    - Keep non-tail-sampled wiring unchanged.
  MODIFY packages/logfire-node/src/__test__/sdk.test.ts:
    - Assert pending-span deferred processor is passed when tail sampling is enabled.
    - Assert pending-span direct processor is still used when tail sampling is disabled.

Task 5: Release metadata
  CREATE .changeset/<descriptive-name>.md:
    - Patch bump `logfire` and `@pydantic/logfire-node`.
    - Mention pending spans now work with tail sampling without exporting dropped traces.
```

### Integration Points

```yaml
SHARED:
  - packages/logfire-api/src/TailSamplingProcessor.ts
  - packages/logfire-api/src/PendingSpanProcessor.ts

NODE:
  - packages/logfire-node/src/sdk.ts

TESTS:
  - packages/logfire-api/src/sampling.test.ts
  - packages/logfire-node/src/__test__/sdk.test.ts
```

## Validation

Run focused checks:

```bash
vp run logfire#test
vp run logfire#typecheck
vp run @pydantic/logfire-node#test
vp run @pydantic/logfire-node#typecheck
```

Run broader checks before PR:

```bash
pnpm run build
pnpm run format-check
```

### Required Test Coverage

- [ ] Tail-sampled accepted traces emit pending spans for still-recording eligible spans.
- [ ] Child spans started after trace acceptance emit pending spans through the accepted fast path.
- [ ] Child spans started after acceptance from a prior span's `onEnd` emit pending spans through the accepted fast path.
- [ ] Tail-sampled dropped traces emit no pending spans.
- [ ] Late children of dropped traces do not emit pending spans, documenting the intentional JS behavior.
- [ ] Multiple accepted still-recording spans emit multiple pending spans.
- [ ] Already-ended accepted spans do not require pending spans, matching Python.
- [ ] Existing skip rules still apply in the deferred path.
- [ ] Flush/shutdown do not double-call shared processors.
- [ ] Node tail-sampled wiring uses the deferred processor.
- [ ] Accepted root end clears the accepted-trace sentinel to avoid unbounded map growth.
- [ ] Children that start after accepted root end do not require pending spans, documenting the memory-bounding trade-off.

## Unknowns & Risks

- This is the most subtle PR in the sequence. The main risk is accidentally exporting pending spans for traces that tail sampling drops.
- The exact replay data needed by `PendingSpanProcessor.onStart()` may require small changes to the current tail-sampling buffer shape.
- Processor ownership must be clear to avoid double shutdown.
- Tests must use realistic span recording state for at least one deferred replay case. Mocks that always return `isRecording() === true` can hide the ended-span behavior.
- Tests must set `TraceFlags.SAMPLED` on spans expected to produce pending placeholders, since `PendingSpanProcessor` silently skips unsampled spans.
- Splitting buffered start/end entries into typed collections is part of this PRP. Do not remove the existing wrapped-start buffering unless intentionally changing JS tail-sampling architecture in a later PR.

**Confidence: 7/10** for one-pass implementation success now that the Python parity boundary, accepted fast path, and option-2 buffer cleanup are explicit.
