## Goal

Change Cloudflare Worker HTTP header span attributes from capture-all-by-default to
explicit opt-in capture in `@pydantic/otel-cf-workers`, and make the Logfire
Cloudflare wrapper inherit that safer behavior.

The implementation should:

- Stop emitting `http.request.header.<key>` and `http.response.header.<key>` by
  default.
- Add a first-class config surface for explicitly captured request and response
  headers on Worker inbound fetch, outbound fetch, and Durable Object fetch spans.
- Emit captured header attributes in the OpenTelemetry semantic convention value
  shape: a string array, usually `[value]` with the Fetch `Headers` API.
- Keep existing non-header HTTP semantic attributes such as method, body size,
  status code, content type, user agent, URL, and Cloudflare metadata.
- Document the behavior change and migration path for users who intentionally
  depended on full header capture.

## Why

- GitHub issue [#158](https://github.com/pydantic/logfire-js/issues/158) points
  out that current fetch instrumentation records all headers, including cookies,
  authorization values, and other credential-bearing headers.
- OpenTelemetry semantic conventions explicitly warn that instrumentations should
  require configuration for captured request and response headers because
  capture-all behavior can leak sensitive data.
- `@pydantic/logfire-cf-workers` has default scrubbing, but the lower-level
  `@pydantic/otel-cf-workers` package does not, and Logfire scrubbing can be
  disabled. The safe behavior needs to live at the instrumentation source.
- The current implementation also emits scalar strings for header values, while
  the semantic convention defines these attributes as `string[]`.

## Success Criteria

- [ ] By default, `gatherRequestAttributes()` emits no
      `http.request.header.*` attributes.
- [ ] By default, `gatherResponseAttributes()` emits no
      `http.response.header.*` attributes.
- [ ] Users can explicitly opt in to request and response header capture for
      both `handlers.fetch` and outbound `fetch` instrumentation.
- [ ] Explicit capture supports at least case-insensitive header-name lists and
      an escape hatch that can intentionally capture every header.
- [ ] Captured request headers use `http.request.header.<lowercase-name>` with
      values shaped as `string[]`.
- [ ] Captured response headers use `http.response.header.<lowercase-name>` with
      values shaped as `string[]`.
- [ ] Worker fetch handler spans, outbound global fetch spans, service binding
      outbound fetch spans, Durable Object inbound fetch spans, and Durable
      Object stub outbound fetch spans all use the same config semantics.
- [ ] Existing dedicated semantic attributes still appear where currently
      supported: `http.request.method`, `http.request.body.size`,
      `user_agent.original`, `http.mime_type`, `http.accepts`, `url.*`,
      `http.response.status_code`, `http.response.body.size`, and Cloudflare
      attributes.
- [ ] `@pydantic/logfire-cf-workers` exposes the new config through its existing
      `fetch` and `handlers` option passthrough without adding wrapper-only
      behavior.
- [ ] README and changelog/changeset explain the default change and show how to
      migrate to explicit request and response header capture.
- [ ] Focused validation passes:
      `vp run @pydantic/otel-cf-workers#test -- fetch`,
      `vp run @pydantic/otel-cf-workers#test -- do`,
      `vp run @pydantic/otel-cf-workers#typecheck`,
      `vp run @pydantic/logfire-cf-workers#typecheck`, and relevant package
      builds.

## Clarifications

### Session 2026-07-08

- Q: Should the PRP lock the public header capture API to `captureHeaders` with
  case-insensitive header-name arrays, explicit `true` for full capture, and
  predicate functions? -> A: Yes. Use the recommended `captureHeaders` API with
  arrays, `true`, and predicates.
- Q: Should the PRP require major changesets for both
  `@pydantic/otel-cf-workers` and `@pydantic/logfire-cf-workers`? -> A: Yes.
  Treat the default span-attribute removal as semver-breaking for both packages.
- Q: Should response header capture stay in scope alongside request header
  capture? -> A: Yes. Disable both request and response header capture by
  default, and allow both to be explicitly opted in.

## Context

### Key Files

- `packages/otel-cf-workers/src/instrumentation/fetch.ts` - current source of
  request and response header capture. `gatherRequestAttributes()` loops over all
  request headers and `gatherResponseAttributes()` loops over all response
  headers.
- `packages/otel-cf-workers/src/instrumentation/do.ts` - Durable Object inbound
  fetch spans reuse the same gather helpers, and Durable Object stubs use
  `instrumentClientFetch()`.
- `packages/otel-cf-workers/src/instrumentation/service.ts` - service binding
  outbound fetch spans use `instrumentClientFetch()`.
- `packages/otel-cf-workers/src/types.ts` - public `TraceConfig`,
  `FetcherConfig`, and `FetchHandlerConfig` type surface where header capture
  config should be exposed.
- `packages/otel-cf-workers/src/config.ts` - normalizes supplied config into
  `ResolvedTraceConfig`; default header capture should normalize to disabled.
- `packages/otel-cf-workers/src/sdk.ts` - initializes global fetch
  instrumentation and wraps Worker handlers.
- `packages/otel-cf-workers/test/instrumentation/fetch.test.ts` - existing fetch
  instrumentation tests. Add direct gather-helper tests and outbound fetch config
  tests here.
- `packages/otel-cf-workers/test/instrumentation/do.test.ts` - existing Durable
  Object wrapper tests. Add or extend tests if DO config plumbing needs coverage.
- `packages/logfire-cf-workers/src/index.ts` - Logfire wrapper config passthrough
  and scrubbing/post-processing. It should not reintroduce capture-all behavior.
- `packages/otel-cf-workers/README.md` - lower-level Cloudflare Worker
  instrumentation docs. Add header capture configuration docs here.
- `packages/logfire-cf-workers/README.md` - Logfire Cloudflare docs. Add a short
  note that header capture is explicit and uses the lower-level config fields.
- `.changeset/` - add a changeset because this changes package-visible span
  attributes and adds public configuration.

### External References

- [OpenTelemetry HTTP semantic convention attributes](https://opentelemetry.io/docs/specs/semconv/registry/attributes/http/#http-request-header)
  - `http.request.header.<key>` and `http.response.header.<key>` require explicit
    configuration guidance.
  - Header values are defined as arrays of strings.
- [GitHub issue #158](https://github.com/pydantic/logfire-js/issues/158) -
  originating report and motivation.

### Gotchas

- This is a behavior change for users who rely on `http.request.header.*` or
  `http.response.header.*` being present on every Cloudflare Worker span. Treat
  it as semver-significant.
- `@pydantic/logfire-cf-workers` default scrubbing currently mitigates some keys
  such as `authorization` and `cookie`, but scrubbing is not a replacement for
  opt-in capture and can be disabled.
- `Headers.entries()` returns lower-case names in standard Fetch implementations,
  but the implementation should normalize names defensively so config matching is
  case-insensitive and emitted attribute keys are lower-case.
- Fetch `Headers` exposes combined header values as strings. Emit `[value]` for
  captured values rather than trying to split comma-separated values; the
  semantic convention allows either a single-item array containing the combined
  string or multiple values depending on the library.
- Keep trace-context propagation separate from header capture. `traceparent`,
  `tracestate`, and `baggage` may be injected/extracted without being recorded
  as span attributes unless the user explicitly opts into capturing those header
  names.
- Existing `http.mime_type` is set from `content-type` for both request and
  response attributes. Do not remove it as part of the header-capture change.
- The current attribute object types are `Record<string, string | number>` in
  helper functions; captured header arrays require widening those local types to
  OpenTelemetry `Attributes` or an equivalent value type.
- Durable Object stub outbound fetch currently calls `instrumentClientFetch()`
  with a fixed config function that only sets `includeTraceContext: true`. It
  will need a deliberate path to preserve that propagation behavior while still
  honoring the active fetch header capture config.

## Implementation Blueprint

### Data Models

Public config shape:

```ts
export type HeaderCapturePredicate = (name: string, value: string) => boolean
export type HeaderCaptureSelector = boolean | readonly string[] | HeaderCapturePredicate

export interface HeaderCaptureConfig {
  request?: HeaderCaptureSelector
  response?: HeaderCaptureSelector
}

export interface FetcherConfig {
  includeTraceContext?: boolean | IncludeTraceContextFn
  captureHeaders?: HeaderCaptureConfig
}

export interface FetchHandlerConfig {
  acceptTraceContext?: boolean | AcceptTraceContextFn
  captureHeaders?: HeaderCaptureConfig
}
```

Semantics:

- `undefined`, `false`, or an empty array captures no headers.
- `true` explicitly captures all headers.
- `string[]` captures only those names, matched case-insensitively.
- `HeaderCapturePredicate` is called with lower-case header name and string value.
  Returning `true` captures that header.
- Captured attributes use the normalized lower-case header name.
- Captured values are arrays: `attrs["http.request.header.x-request-id"] =
["abc"]`.

### Tasks

```yaml
Task 1: Header capture helpers
  MODIFY packages/otel-cf-workers/src/instrumentation/fetch.ts:
    - Add HeaderCapturePredicate, HeaderCaptureSelector, and HeaderCaptureConfig types.
    - Add a helper that normalizes a selector into "capture none", "capture all",
      name set, or predicate.
    - Add a helper that copies matching Headers entries into attributes under a
      supplied prefix.
    - Normalize emitted header names to lower-case.
    - Emit captured header values as [value].
  PATTERN:
    - Keep helper functions small and local to fetch instrumentation unless tests
      show reuse pressure.

Task 2: Public config surface and defaults
  MODIFY packages/otel-cf-workers/src/instrumentation/fetch.ts:
    - Extend FetcherConfig with captureHeaders?: HeaderCaptureConfig.
    - Extend FetchHandlerConfig with captureHeaders?: HeaderCaptureConfig.
  MODIFY packages/otel-cf-workers/src/types.ts:
    - Ensure ResolvedTraceConfig still marks fetch and handlers.fetch as required.
  MODIFY packages/otel-cf-workers/src/config.ts:
    - Preserve includeTraceContext and acceptTraceContext defaults.
    - Normalize captureHeaders to an object with request/response disabled by
      default, or preserve undefined with helper-level defaults.
  GOTCHA:
    - Do not default to true for compatibility; the explicit goal is safer
      default behavior.

Task 3: Wire request/response capture into span creation
  MODIFY packages/otel-cf-workers/src/instrumentation/fetch.ts:
    - Change gatherRequestAttributes(request) to accept an optional
      HeaderCaptureSelector for request headers.
    - Change gatherResponseAttributes(response) to accept an optional
      HeaderCaptureSelector for response headers.
    - In executeFetchHandler(), use active handlers.fetch.captureHeaders
      selectors for inbound request and response.
    - In instrumentClientFetch(), use active fetch.captureHeaders selectors for
      outbound request and response.
  MODIFY packages/otel-cf-workers/src/instrumentation/do.ts:
    - Ensure Durable Object inbound fetch spans use handlers.fetch.captureHeaders.
    - Ensure Durable Object stub outbound fetch keeps includeTraceContext true
      while honoring active fetch.captureHeaders for request/response capture.
  MODIFY packages/otel-cf-workers/src/instrumentation/service.ts:
    - Ensure service binding outbound fetch keeps includeTraceContext true while
      honoring active fetch.captureHeaders for request/response capture.
  PATTERN:
    - Prefer passing selectors explicitly to gather helpers over making helpers
      read global context directly.

Task 4: Tests for defaults and opt-in behavior
  MODIFY packages/otel-cf-workers/test/instrumentation/fetch.test.ts:
    - Add direct tests for gatherRequestAttributes default behavior:
      Authorization, Cookie, and X-Request-Id are not emitted as header
      attributes by default.
    - Add direct tests for gatherResponseAttributes default behavior:
      Set-Cookie and X-Response-Id are not emitted by default.
    - Add tests for string-list selectors, including mixed-case config names.
    - Add tests for true selectors capturing all headers.
    - Add tests for predicate selectors capturing selected names.
    - Assert captured values are arrays, not scalar strings.
    - Assert existing dedicated attributes still appear where expected.
    - Add outbound instrumentClientFetch tests that verify the resolved fetch
      config controls request and response header capture.
  MODIFY packages/otel-cf-workers/test/instrumentation/do.test.ts:
    - Add coverage only if config plumbing cannot be adequately covered by fetch
      tests. Prefer a focused test that proves DO inbound fetch does not capture
      sensitive headers by default and honors explicit config.
  MODIFY packages/otel-cf-workers/test/instrumentation/service.test.ts:
    - Add a focused regression test that proves service binding outbound fetch
      honors explicit fetch header capture config.

Task 5: Documentation and migration notes
  MODIFY packages/otel-cf-workers/README.md:
    - Under Fetch configuration, document captureHeaders.request and
      captureHeaders.response.
    - Include examples:
        fetch: { captureHeaders: { request: ["x-request-id"] } }
        handlers: { fetch: { captureHeaders: { response: ["cache-control"] } } }
        captureHeaders: { request: true, response: true } for intentional full
        capture with a warning.
    - State that no request/response headers are captured by default.
  MODIFY packages/logfire-cf-workers/README.md:
    - Add a short Logfire-specific note and point users to the same config shape.
    - Mention that Logfire scrubbing remains useful but capture is now explicit.

Task 6: Release metadata
  CREATE .changeset/<generated-name>.md:
    - Bump @pydantic/otel-cf-workers for the default behavior change and new
      config.
    - Bump @pydantic/logfire-cf-workers because its exported instrumentation
      behavior changes through the dependency.
    - Use major bumps for both packages.
  NOTE:
    - The changeset should clearly call out the migration path:
      set captureHeaders.request/response to explicit header names, or true if
      full capture is intentionally required.
```

### Integration Points

```yaml
CONFIG:
  - packages/otel-cf-workers/src/types.ts
    Public TraceConfig type surface.
  - packages/otel-cf-workers/src/config.ts
    Default normalization for fetch and handlers.fetch.

INSTRUMENTATION:
  - packages/otel-cf-workers/src/instrumentation/fetch.ts
    Worker fetch handler spans and outbound fetch spans.
  - packages/otel-cf-workers/src/instrumentation/do.ts
    Durable Object inbound and stub outbound fetch spans.
  - packages/otel-cf-workers/src/instrumentation/service.ts
    Service binding outbound fetch spans.

LOGFIRE WRAPPER:
  - packages/logfire-cf-workers/src/index.ts
    Config passthrough through ConfigOptionsBase should automatically expose
    the new lower-level fields.

DOCS:
  - packages/otel-cf-workers/README.md
  - packages/logfire-cf-workers/README.md

RELEASE:
  - .changeset/*.md
```

## Validation

Run focused validation while implementing:

```bash
vp run @pydantic/otel-cf-workers#test -- fetch
vp run @pydantic/otel-cf-workers#test -- do
vp run @pydantic/otel-cf-workers#typecheck
vp run @pydantic/logfire-cf-workers#typecheck
```

Run package builds before opening a PR:

```bash
vp run @pydantic/otel-cf-workers#build
vp run @pydantic/logfire-cf-workers#build
```

If the implementation touches shared config or exported types in a broader way,
also run:

```bash
pnpm run test
pnpm run typecheck
```

### Required Test Coverage

- [ ] Default request header capture is disabled.
- [ ] Default response header capture is disabled.
- [ ] Sensitive request headers are not emitted by default.
- [ ] Sensitive response headers are not emitted by default.
- [ ] Name-list selectors match case-insensitively.
- [ ] Predicate selectors can capture a subset of headers.
- [ ] Explicit `true` selectors capture all headers.
- [ ] Captured header values are arrays.
- [ ] Dedicated non-header HTTP semantic attributes still appear.
- [ ] Outbound fetch instrumentation uses `fetch.captureHeaders`.
- [ ] Inbound Worker fetch instrumentation uses `handlers.fetch.captureHeaders`.
- [ ] Durable Object fetch paths follow the same default and opt-in behavior.
- [ ] Service binding fetch paths follow the same default and opt-in behavior.

## Unknowns & Risks

- Some users may have relied on all response headers as well as request headers.
  The issue text names request headers, but OpenTelemetry gives the same guidance
  for response headers, and the local code captures both by default. This PRP
  intentionally changes both request and response header capture defaults.
- Predicate config functions make the public API more flexible but require clear
  examples and direct tests. The PRP intentionally includes predicates as part of
  the committed API.
- Durable Object stub outbound fetch currently has special trace-context behavior.
  Be careful not to regress propagation while adding header capture config.
- `postProcessor` can already remove or redact attributes. It should remain a
  backstop, not the recommended way to avoid sensitive header capture.

**Confidence: 8/10** for one-pass implementation success.
