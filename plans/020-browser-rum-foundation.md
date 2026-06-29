# Browser RUM Foundation

## Goal

Add the browser SDK foundation needed for Logfire RUM and session replay
correlation without enabling high-volume RUM capture by default.

The end state is:

- `@pydantic/logfire-browser` exposes a supported way to register additional
  span processors at provider construction time.
- The browser SDK can own a per-tab browser session id with idle and max-duration
  rotation.
- When `rum.session` is enabled, every browser span gets `session.id`,
  compatibility `browser.session.id`, `url.full`, and `url.path` at span start.
- Platform can remove its local `@pydantic/logfire-browser` patch for custom span
  processors.

This PRP deliberately excludes Core Web Vitals reporting, rrweb replay package
creation, and Platform migration. Those are follow-up PRPs.

## Why

- Platform's RUM/replay POC currently patches `@pydantic/logfire-browser` to add
  `spanProcessors`. The SDK should expose the needed extension point directly.
- RUM and replay both need a stable session join key even when replay is
  disabled or sampled out.
- A first-class browser session processor makes browser spans queryable by
  session/page in Logfire and gives future Web Vitals spans the right context.
- Keeping this opt-in avoids changing telemetry volume for existing browser SDK
  users.

## Success Criteria

- [ ] `LogfireConfigOptions` accepts `spanProcessors?: SpanProcessor[]`, and
      configured processors are passed into `WebTracerProvider`.
- [ ] `LogfireConfigOptions` accepts an opt-in `rum.session` configuration.
- [ ] When browser session capture is enabled, every span started by the
      configured provider receives `session.id`, `browser.session.id`,
      `url.full`, and `url.path`.
- [ ] Browser sessions persist per tab across page loads through
      `sessionStorage`, rotate after idle timeout, and rotate after max duration.
- [ ] Existing behavior is unchanged when `rum.session` is not enabled.
- [ ] Unit tests cover processor registration, session attribute stamping,
      disabled behavior, storage fallback, idle rotation, and max-duration
      rotation.
- [ ] Browser README/docs describe the opt-in `rum.session` behavior and processor
      extension point.

## Context

### Key Files

- `packages/logfire-browser/src/index.ts` - owns `configure()`,
  `LogfireConfigOptions`, provider construction, and the current closed
  `spanProcessors: [spanProcessor]` array.
- `packages/logfire-browser/src/index.test.ts` - existing configure tests mock
  `WebTracerProvider` and inspect provider options.
- `packages/logfire-browser/src/LogfireSpanProcessor.ts` - current built-in
  wrapper for console export and span-name adjustments.
- `packages/logfire-browser/package.json` - package dependencies and peer
  dependencies. This foundation should not add heavy runtime dependencies.
- `packages/logfire-browser/README.md` - package-level browser SDK docs.
- `docs/packages/browser.md` - docs-site browser package page.
- `examples/browser/src/main.ts` - vanilla browser example with web auto
  instrumentation already configured by the app.
- `examples/nextjs-client-side-instrumentation/app/components/ClientInstrumentationProvider.tsx`
  - example of client-side `logfire.configure()` in React.
- `../platform/src/services/logfire-frontend/patches/@pydantic__logfire-browser@0.12.2.patch`
  - Platform's current local patch adding `spanProcessors`.
- `../platform/src/services/logfire-frontend/src/packages/instrumentation/browser-session.ts`
  - Platform's bridge implementation that stamps `browser.session.id` and URL
    attributes.
- `../platform/src/packages/session-replay-sdk/src/session.ts` - POC
  session-storage lifecycle with idle and max-duration rotation.
- `docs/rum-session-replay-prp-roadmap.md` - overall PRP decomposition.
- `docs/session-replay-integration.md` - handoff details for the replay package
  and Platform migration.

### External References

- https://opentelemetry.io/docs/specs/semconv/registry/attributes/session/ -
  OpenTelemetry session semantic attributes. `session.id` is the standard
  attribute; `browser.session.id` is Platform compatibility.
- https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/metapackages/auto-instrumentations-web -
  browser auto-instrumentation package used by examples and Platform.
- https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/packages/instrumentation-document-load -
  document-load instrumentation emits `documentLoad` and `resourceFetch` spans
  and supports stable HTTP semconv opt-in.
- https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/packages/instrumentation-user-interaction -
  user interaction instrumentation defaults to click events and does not emit
  semantic-convention attributes itself.

### Gotchas

- OpenTelemetry JS 2.x requires span processors at provider construction time;
  they cannot be appended to a provider after registration.
- User-provided span processors passed as independent processors may observe
  spans outside Logfire's built-in tail sampling/export pipeline. Document this
  and keep the option clearly advanced.
- Browser `sessionStorage` can throw or be unavailable in private modes and
  unusual browser contexts. The session manager must fall back to memory.
- Do not store session ids as resource attributes. The session can rotate during
  a page lifetime, so it must be stamped on spans at start time.
- Do not make `rum: true` or browser sessions default-on in this PRP.
  Default-on changes the attribute surface for all browser users, and `rum: true`
  should eventually imply a more complete RUM stack than session identity alone.
- Platform currently queries `browser.session.id`; the SDK should emit both
  `session.id` and `browser.session.id` until Platform migrates.
- Existing `configure()` returns only an async cleanup function. If this PRP
  needs public session access, prefer module-level helpers such as
  `getBrowserSessionId()` over changing the return type.
- Emit `url.path` and `url.full` by default for Platform parity, but allow
  `rum.session` callers to customize or suppress these URL attributes so apps
  with sensitive URL structures can avoid exporting raw query strings or
  fragments.

## Implementation Blueprint

### Data Models

```ts
export interface BrowserSessionOptions {
  /**
   * Session inactivity timeout. Defaults to 30 minutes.
   */
  idleTimeoutMs?: number
  /**
   * Hard cap on one browser session. Defaults to 4 hours.
   */
  maxDurationMs?: number
  /**
   * Storage key for tests or advanced embedding. Defaults to
   * `lf_browser_session`.
   */
  storageKey?: string
  /**
   * Controls URL attributes stamped on session/RUM spans. Defaults to emitting
   * `url.full = window.location.href` and `url.path = window.location.pathname`.
   * Set to false to suppress URL attributes, or return sanitized values.
   */
  urlAttributes?: false | ((url: URL) => BrowserSessionUrlAttributes)
}

export interface BrowserSessionUrlAttributes {
  full?: string
  path?: string
}

export interface BrowserSessionState {
  id: string
  startedAt: number
  lastActivityAt: number
}

export interface RUMOptions {
  /**
   * Enable browser session identity and session/page span attributes.
   */
  session?: boolean | BrowserSessionOptions
}

export interface LogfireConfigOptions {
  spanProcessors?: SpanProcessor[]
  rum?: RUMOptions
}
```

Recommended defaults:

```ts
const DEFAULT_BROWSER_SESSION_OPTIONS = {
  idleTimeoutMs: 30 * 60_000,
  maxDurationMs: 4 * 60 * 60_000,
  storageKey: 'lf_browser_session',
}
```

Recommended session id:

- Prefer `crypto.randomUUID()` when available.
- Fall back to a timestamp plus cryptographic/random bytes if `crypto.randomUUID`
  is unavailable.
- The id only needs to be unique; sortable UUIDv7 is not required for this PRP.

### Tasks

```yaml
Task 1: Add Browser Session Module
  CREATE packages/logfire-browser/src/browserSession.ts:
    - Define BrowserSessionOptions and BrowserSessionState.
    - Implement BrowserSessionManager with getSession(), touch(), reset().
    - Persist state in sessionStorage by default.
    - Fall back to in-memory state when storage is unavailable or throws.
    - Export getBrowserSessionId() for future replay integration.
    - Export resetBrowserSession() only if needed for tests/logout support.
  PATTERN:
    - ../platform/src/packages/session-replay-sdk/src/session.ts
    - ../platform/src/services/logfire-frontend/src/packages/instrumentation/browser-session.ts

Task 2: Add Browser Session Span Processor
  CREATE packages/logfire-browser/src/BrowserSessionSpanProcessor.ts:
    - Implement SpanProcessor.
    - On onStart(), call manager.touch() and set:
      - session.id
      - browser.session.id
      - url.full
      - url.path
    - Default URL attributes to `window.location.href` and
      `window.location.pathname`.
    - If `urlAttributes` is false, do not stamp URL attributes.
    - If `urlAttributes` is a function, stamp only the sanitized `full` and
      `path` values it returns.
    - Keep forceFlush() and shutdown() as resolved promises.
    - Avoid throwing if window/location is unavailable.
  PATTERN:
    - ../platform/src/services/logfire-frontend/src/packages/instrumentation/browser-session.ts

Task 3: Extend Configure Options
  MODIFY packages/logfire-browser/src/index.ts:
    - Add `spanProcessors?: SpanProcessor[]` to LogfireConfigOptions.
    - Add `rum?: RUMOptions`.
    - When `rum.session` is enabled, create BrowserSessionManager and
      BrowserSessionSpanProcessor.
    - Construct provider span processors in this order:
      1. browser session processor when `rum.session` is enabled
      2. user-provided spanProcessors
      3. built-in Logfire export processor, wrapped by tail sampling when configured
    - Preserve current behavior when neither option is provided.
  PATTERN:
    - Platform patch spreads custom processors before built-in export processor.
    - Existing tail sampling wraps only the built-in exporting processor.

Task 4: Export Public Helpers
  MODIFY packages/logfire-browser/src/index.ts:
    - Export browser session option types if defined in browserSession.ts.
    - Export BrowserSessionUrlAttributes.
    - Export RUMOptions if defined in index.ts or a separate rum.ts module.
    - Export getBrowserSessionId() if implemented.
    - Add exports to defaultExport only for runtime functions, not type-only exports.

Task 5: Add Tests
  MODIFY packages/logfire-browser/src/index.test.ts:
    - Assert custom spanProcessors appear in WebTracerProvider options.
    - Assert custom processors are ordered before the built-in Logfire processor.
    - Assert browser session processor is included only when `rum.session` is enabled.
    - Assert browser session processor is ordered before user spanProcessors.
  CREATE packages/logfire-browser/src/browserSession.test.ts:
    - Persists session state in storage.
    - Falls back to memory when storage throws.
    - Rotates after idle timeout.
    - Rotates after max duration.
    - Reuses active session across manager instances with the same storage.
  CREATE packages/logfire-browser/src/BrowserSessionSpanProcessor.test.ts:
    - Stamps session.id and browser.session.id.
    - Stamps default url.full and url.path.
    - Suppresses URL attributes with `urlAttributes: false`.
    - Applies sanitized URL attributes from `urlAttributes(url)`.
    - Does not throw if location access is unavailable.

Task 6: Update Documentation and Examples
  MODIFY packages/logfire-browser/README.md:
    - Document `spanProcessors` as an advanced extension point.
    - Document opt-in `rum.session` behavior and emitted attributes.
    - Document `rum.session.urlAttributes` for sanitizing or suppressing
      `url.full` and `url.path`.
    - Explain that `session.id` is standard and `browser.session.id` is emitted
      for Logfire Platform compatibility.
  MODIFY docs/packages/browser.md:
    - Add the same public API guidance in docs-site form.
  MODIFY examples/browser/src/main.ts OR add a short commented snippet:
    - Show `rum: { session: true }` only if it does not distract from the example.
```

### Integration Points

```yaml
CONFIG:
  - packages/logfire-browser/src/index.ts
    Add LogfireConfigOptions.rum and LogfireConfigOptions.spanProcessors.

TRACE PROVIDER:
  - packages/logfire-browser/src/index.ts
    Include the internal session processor and custom processors in the
    WebTracerProvider constructor.

PUBLIC API:
  - packages/logfire-browser/src/index.ts
    Export browser session helpers/types needed by future replay integration.

DOCS:
  - packages/logfire-browser/README.md
  - docs/packages/browser.md
```

No database, route, or backend changes are part of this PRP.

## Validation

Run these from the repository root:

```bash
vp run @pydantic/logfire-browser#test
vp run @pydantic/logfire-browser#typecheck
vp run @pydantic/logfire-browser#build
```

For broader confidence before PR:

```bash
pnpm run format-check
pnpm run build
```

### Required Test Coverage

- [ ] `spanProcessors` option preserves caller-provided processor instances in
      provider construction.
- [ ] Built-in exporting processor remains installed when custom processors are
      provided.
- [ ] Tail sampling still wraps only the built-in exporting processor.
- [ ] Browser session processor is absent by default and when `rum.session` is
      omitted or false.
- [ ] Browser session processor stamps `session.id`, `browser.session.id`,
      `url.full`, and `url.path` when enabled.
- [ ] Browser session processor supports suppressing URL attributes.
- [ ] Browser session processor supports sanitized URL attributes.
- [ ] Browser session state persists in `sessionStorage`.
- [ ] Browser session state rotates on idle timeout.
- [ ] Browser session state rotates on max duration.
- [ ] Browser session state falls back to memory when storage throws.

## Clarifications

### Session 2026-06-29

- Q: Should PRP 020 expose a low-level `browserSession` option or a higher-level,
  more opinionated RUM API shape? -> A: Use the product namespace now:
  `rum: { session: true }` or `rum: { session: { ... } }`. Do not add
  `rum: true` yet, because that should eventually imply the full opinionated
  RUM stack, not only session identity. Keep `spanProcessors` as an advanced
  extension point, not the main Platform/RUM integration path.
- Q: Which URL attributes should the session span processor stamp? -> A: By
  default, stamp both `url.path` and `url.full` for Platform parity. Also add an
  optional `rum.session.urlAttributes` hook in this PRP so callers can sanitize
  or suppress URL attributes when full URLs may contain sensitive query strings
  or fragments.
- Q: How should `getBrowserSessionId()` behave after
  `configure({ rum: { session: true } })` but before the first span? -> A:
  Export it and lazily create/touch the configured session so replay integration
  can get a usable SDK-owned session id immediately.

## Clarification Questions Before Execution

No blocking clarification questions remain for PRP 020. Execute with the
decisions recorded above: `rum.session` API, both session attributes,
Platform-compatible URL attributes with an optional sanitizer/suppression hook,
and lazy `getBrowserSessionId()`.

## Unknowns & Risks

- The top-level `rum` namespace is settled for this PRP, but the exact future
  fields for Web Vitals, auto-instrumentations, and replay are not. Keeping PRP
  020 to `rum.session` reduces rework.
- `spanProcessors` is powerful and can be misused to bypass Logfire sampling if
  callers install their own exporting processors. Documentation should frame it
  as advanced.
- Lazy `getBrowserSessionId()` needs access to the configured session manager
  without changing `configure()`'s cleanup return type. Keep this as module
  state and make tests reset it between cases.
- Session id generation format may later align with replay's UUIDv7 POC. This
  PRP only requires uniqueness.

**Confidence: 8/10** for one-pass implementation success after the clarification
questions are accepted.
