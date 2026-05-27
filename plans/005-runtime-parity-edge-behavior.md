## Goal

Make Browser cleanup safe to call repeatedly, verify Cloudflare Worker request-lifetime export behavior, and document Browser/Cloudflare lifecycle semantics.

This PRP intentionally has no implementation dependency on PRPs 003, 004, or 007. Browser pending-span parity is now split out into PRP 007.

This PRP is intentionally scoped to:

- Browser cleanup idempotency and concurrency behavior
- Browser lifecycle documentation for cleanup and page-hide auto-flush
- Cloudflare Worker `ctx.waitUntil()` export verification and documentation
- PR description notes with exact verification references for installed Worker dependencies

Out of scope:

- Browser pending-span parity, covered by PRP 007
- Node process signal/error-handler refinement, covered by PRP 006
- Cloudflare code changes unless verification proves a Logfire-managed processor path is missing

## Why

- Browser and Cloudflare have runtime-specific lifecycle mechanics that should not be forced into the Node shutdown model.
- Browser cleanup already flushes before shutdown, but repeated and concurrent cleanup should be safe.
- Cloudflare Workers should rely on request-lifetime `ctx.waitUntil()` export, but that behavior should be verified against the installed dependency and documented.
- Users currently lack clear guidance on what "shutdown" means in non-Node runtimes.

## Success Criteria

- [ ] Browser cleanup returned by `configure()` is idempotent.
- [ ] Concurrent Browser cleanup calls share one in-flight cleanup promise.
- [ ] Browser cleanup unregisters instrumentation, force-flushes, and shuts down in a stable order.
- [ ] Browser cleanup attempts the full cleanup sequence even if an earlier cleanup step fails, and later calls return the same settled/rejected promise rather than retrying.
- [ ] Browser docs explain cleanup semantics and OpenTelemetry page-hide auto-flush behavior, including the `disableAutoFlushOnDocumentHide` caveat.
- [ ] Cloudflare Worker export behavior is verified against the installed `@pydantic/otel-cf-workers` package.
- [ ] Cloudflare docs explain request-lifetime export via `ctx.waitUntil()` and the absence of process-style shutdown.
- [ ] Cloudflare verification covers both `instrumentInProcess()` and `instrumentTail()` Logfire entrypoints, or documents why a mode does not use request-lifetime export.

## Context

### Key Files

- `packages/logfire-browser/src/index.ts` - Browser `configure()`, trace provider construction, returned cleanup function.
- `packages/logfire-browser/src/LogfireSpanProcessor.ts` - Browser processor wrapper.
- `packages/logfire-browser/src/index.test.ts` - Browser provider and cleanup tests.
- `packages/logfire-cf-workers/src/index.ts` - Cloudflare Worker configuration entrypoint.
- `packages/logfire-cf-workers/src/TailWorkerExporter.ts` - Worker tail exporter shutdown behavior.
- `packages/logfire-cf-workers/src/LogfireCloudflareConsoleSpanExporter.ts` - Worker console exporter flush/shutdown behavior.
- `packages/logfire-browser/README.md`, `packages/logfire-cf-workers/README.md` - runtime-specific lifecycle documentation.

### Local OpenTelemetry References

- Resolve the installed `@pydantic/otel-cf-workers` package root, then inspect `dist/index.mjs` and/or `dist/index.js.map`. The package does not ship a local `src/index.ts` under pnpm.
- `node_modules/.pnpm/@opentelemetry+sdk-trace-base@*/node_modules/@opentelemetry/sdk-trace-base/build/src/platform/browser/export/BatchSpanProcessor.js` - Browser batch processor auto-flushes on `visibilitychange` hidden and `pagehide`, unless `disableAutoFlushOnDocumentHide` is true.

### Gotchas

- Browser has no process shutdown. Do not copy Node process handlers into Browser.
- Browser already has OpenTelemetry auto-flush on page hide. Avoid duplicating that mechanism.
- Browser pending spans are intentionally out of scope. Do not add `PendingSpanProcessor` or pending-span docs in this PRP beyond pointing to PRP 007 if needed.
- Cloudflare Workers require `ctx.waitUntil()` for async export after response handling.
- Concurrent calls to the Browser cleanup function must share one promise rather than starting multiple flush/shutdown cycles.
- Cleanup should be idempotent even when the first cleanup attempt rejects. Later calls should return the same rejected promise rather than retrying hidden lifecycle work.

## Implementation Blueprint

### Tasks

```yaml
Task 1: Make Browser cleanup idempotent
  MODIFY packages/logfire-browser/src/index.ts:
    - Store cleanup state inside the returned cleanup closure.
    - On first cleanup call, create and store one cleanup promise.
    - Run cleanup steps in this order: unregister instrumentation, force flush, shutdown.
    - Attempt later cleanup steps even if an earlier step fails; capture the first failure and reject the stored cleanup promise after all cleanup attempts have run.
    - On repeated or concurrent cleanup calls, return the same in-flight/completed/rejected cleanup promise.
    - Preserve existing diagnostic start/complete logging where possible.
  MODIFY packages/logfire-browser/src/index.test.ts:
    - Assert repeated cleanup calls do not double-unregister, double-flush, or double-shutdown.
    - Assert concurrent cleanup calls share one promise.
    - Assert failure in unregister/forceFlush/shutdown does not start a second cleanup on later calls.
    - Assert the stable cleanup order.

Task 2: Verify Cloudflare Worker flush behavior
  READ the installed @pydantic/otel-cf-workers package:
    - Resolve the package root from node_modules instead of using a hardcoded non-existent src path.
    - Confirm request completion schedules `exportSpans(tracker)` via `ctx.waitUntil()`.
    - Confirm `exportSpans()` waits one scheduler tick, waits tracked `waitUntil()` promises, and force-flushes processors.
    - Confirm both `instrumentInProcess()` and `instrumentTail()` call the dependency `instrument()` path and therefore share the same request-lifetime export behavior, or document any difference.
  MODIFY packages/logfire-cf-workers/src/index.ts only if a Logfire-managed processor path is missing from the dependency integration.
  ADD tests only if package code changes.
  CAPTURE the verification result in the PR description with exact file:line references from the installed dependency, so reviewers do not have to re-derive it.

Task 3: Document runtime lifecycle behavior
  MODIFY packages/logfire-browser/README.md:
    - Document cleanup semantics: idempotent, unregisters instrumentation, force-flushes, then shuts down.
    - Document that concurrent cleanup calls share one cleanup promise.
    - Document page-hide auto-flush behavior from the underlying OpenTelemetry batch processor.
    - Mention that page-hide auto-flush can be disabled via `batchSpanProcessorConfig.disableAutoFlushOnDocumentHide`.
    - State that Browser pending-span parity is tracked separately in PRP 007 rather than changed here.
  MODIFY packages/logfire-cf-workers/README.md:
    - Document request-lifetime export via `ctx.waitUntil()`.
    - State that process-style `shutdown()` does not apply to Workers and explain why.
    - Clarify the lifecycle applies to Logfire's in-process and tail Worker entrypoints if verification confirms both share the dependency `instrument()` path.

Task 4: Release metadata
  CREATE .changeset/<descriptive-name>.md:
    - Patch bump `@pydantic/logfire-browser` for cleanup behavior changes.
    - Include `@pydantic/logfire-cf-workers` only if package behavior changes; docs-only updates do not need a version bump.
    - Lead with intent: "Make Browser cleanup safe to call repeatedly" / "Clarify Worker export lifecycle".
```

### Integration Points

```yaml
BROWSER:
  - configure() cleanup closure
  - WebTracerProvider forceFlush/shutdown
  - registerInstrumentations unregister function
  - OpenTelemetry page-hide auto-flush

CLOUDFLARE:
  - @pydantic/otel-cf-workers request tracker
  - ctx.waitUntil()
  - instrumentInProcess()
  - instrumentTail()
  - package docs

DOCS:
  - packages/logfire-browser/README.md
  - packages/logfire-cf-workers/README.md
```

## Validation

Run focused checks:

```bash
vp run @pydantic/logfire-browser#test
vp run @pydantic/logfire-browser#typecheck
vp run @pydantic/logfire-cf-workers#typecheck
```

Run broader checks before PR:

```bash
pnpm run build
pnpm run format-check
```

### Required Test Coverage

- [ ] Browser cleanup idempotency.
- [ ] Browser concurrent cleanup behavior.
- [ ] Browser cleanup order.
- [ ] Browser cleanup failure memoization/no retry.
- [ ] Cloudflare package changes, if any.

## Unknowns & Risks

- Cleanup failure behavior must be explicit so idempotency does not accidentally become "retry after failure."
- Cloudflare behavior likely requires documentation more than code, but verification must happen against the installed dependency rather than from memory.
- The Cloudflare task can collapse to a docs-only change. If that happens, do not invent package code to justify the PRP.

**Confidence: 9/10** for one-pass implementation success now that Browser pending-span parity and Node signal-handler work have been split out.
