# @pydantic/logfire-cf-workers

## 2.0.2

### Patch Changes

- Updated dependencies [f0a67f1]
  - logfire@0.21.1

## 2.0.1

### Patch Changes

- Updated dependencies [ecdfcf1]
- Updated dependencies [38fb2d4]
  - logfire@0.21.0

## 2.0.0

### Major Changes

- 2b94d89: Stop capturing all Cloudflare Worker request and response headers by default.
  Header span attributes now require explicit opt-in through
  `captureHeaders.request` and `captureHeaders.response`, using case-insensitive
  header name arrays, predicate functions, or `true` when full capture is
  intentionally required.

### Patch Changes

- Updated dependencies [2b94d89]
  - @pydantic/otel-cf-workers@2.0.0

## 1.0.0

### Major Changes

- 7378d2b: Move the Cloudflare Worker OpenTelemetry implementation into the monorepo and publish Cloudflare packages as stable ESM-only packages.

  `@pydantic/logfire-cf-workers` now depends on the workspace `@pydantic/otel-cf-workers` package and no longer publishes CommonJS exports or `.d.cts` declarations. `@pydantic/otel-cf-workers` is published from this repository with unified OpenTelemetry catalog dependencies and ESM-only package exports.

### Patch Changes

- Updated dependencies [7378d2b]
  - @pydantic/otel-cf-workers@1.0.0

## 0.12.4

### Patch Changes

- ed748fb: Update OpenTelemetry dependency floors to 2.8.0 / 0.219.0 across published packages.
- Updated dependencies [22bd8ec]
- Updated dependencies [22bd8ec]
- Updated dependencies [ed748fb]
  - logfire@0.20.1

## 0.12.3

### Patch Changes

- Updated dependencies [0c0045c]
  - logfire@0.20.0

## 0.12.2

### Patch Changes

- Updated dependencies [f4ea331]
  - logfire@0.19.0

## 0.12.1

### Patch Changes

- Updated dependencies [b0661cd]
- Updated dependencies [b0661cd]
  - logfire@0.18.0

## 0.12.0

### Minor Changes

- 45c545d: Add scoped manual API clients with `withTags()` and `withSettings()` for reusable tags and default levels.

### Patch Changes

- 45c545d: Add a core `instrument(fn, options?)` wrapper for manual function spans.
- 45c545d: Add `reportError()` options for tags and parent spans, and allow reporting unknown caught values.
- Updated dependencies [45c545d]
- Updated dependencies [45c545d]
- Updated dependencies [45c545d]
- Updated dependencies [45c545d]
- Updated dependencies [45c545d]
- Updated dependencies [45c545d]
  - logfire@0.17.0

## 0.11.11

### Patch Changes

- db97858: Add a shared `startPendingSpan()` helper for explicit pending placeholders without enabling automatic Browser pending spans.
- Updated dependencies [db97858]
- Updated dependencies [db97858]
- Updated dependencies [db97858]
  - logfire@0.16.0

## 0.11.10

### Patch Changes

- 585db46: Broaden OpenTelemetry 0.x catalog ranges so consumers can resolve patched OTel minors between Logfire releases.
- Updated dependencies [585db46]
  - logfire@0.15.2

## 0.11.9

### Patch Changes

- 0a41b45: Update OpenTelemetry peer dependency ranges to the latest JS releases, including the patched Node SDK and auto-instrumentation versions for GHSA-q7rr-3cgh-j5r3.
- Updated dependencies [0a41b45]
  - logfire@0.15.1

## 0.11.8

### Patch Changes

- Updated dependencies [08ecf7f]
  - logfire@0.15.0

## 0.11.7

### Patch Changes

- Updated dependencies [b6e76c2]
  - logfire@0.14.0

## 0.11.6

### Patch Changes

- 51f8ad5: Upgrade the published OpenTelemetry dependency ranges to patched versions and move
  the Cloudflare workers integration to `@pydantic/otel-cf-workers@1.0.0-rc.55`.
- Updated dependencies [51f8ad5]
  - logfire@0.13.2

## 0.11.5

### Patch Changes

- Updated dependencies [894cf8e]
  - logfire@0.13.1

## 0.11.4

### Patch Changes

- Updated dependencies [1b4d704]
  - logfire@0.13.0

## 0.11.3

### Patch Changes

- Updated dependencies [56f5bbb]
  - logfire@0.12.0

## 0.11.2

### Patch Changes

- eeb5801: Update OpenTelemetry dependencies to latest versions

## 0.11.1

### Patch Changes

- 9f03df2: Fix phantom dependencies
- Updated dependencies [9f03df2]
  - logfire@0.11.1

## 0.11.0

### Minor Changes

- 26db714: Use logfire instead of @pydantic/logfire-api

## 0.10.0

### Minor Changes

- 00ffa94: Use logfire instead of @pydantic/logfire-api

## 0.9.0

### Minor Changes

- 03df4fb: Add default export to packages. Using the default import is equivalent to the star import.

### Patch Changes

- Updated dependencies [03df4fb]
  - @pydantic/logfire-api@0.9.0

## 0.8.2

### Patch Changes

- 4ec3564: Diagnostic host message

## 0.8.1

### Patch Changes

- 258969c: Update READMEs

## 0.8.0

### Minor Changes

- 3203828: Support additional span processors for cf workers

## 0.7.0

### Minor Changes

- 5e54d9c: Allow disabling scrubbing
- 0787869: Support console logging of spans for CF workers

## 0.6.0

### Minor Changes

- 71f46db: Auto-close spans opened with logfire.span

### Patch Changes

- Updated dependencies [71f46db]
  - @pydantic/logfire-api@0.6.0

## 0.5.0

### Minor Changes

- 478e045: Experimental browser support

### Patch Changes

- Updated dependencies [478e045]
  - @pydantic/logfire-api@0.5.0

## 0.4.4

### Patch Changes

- df4ac70: Support environment for Cloudflare workers

## 0.4.3

### Patch Changes

- 17dbddd: Re-export instrument function

## 0.4.2

### Patch Changes

- b59e803: Bump to latest otel-cf-workers, fixes span nesting and adds header capturing

## 0.4.1

### Patch Changes

- af427c5: Support for tail worker trace exporting

## 0.4.0

### Minor Changes

- dc0a537: Support for EU tokens. Support span message formatting.

### Patch Changes

- Updated dependencies [dc0a537]
  - @pydantic/logfire-api@0.4.0

## 0.3.0

### Minor Changes

- 6fa1410: API updates, fixes for span kind

### Patch Changes

- Updated dependencies [6fa1410]
  - @pydantic/logfire-api@0.3.0

## 0.2.2

### Patch Changes

- 11c5ac2: Embed microlabs as a dependency

## 0.2.1

### Patch Changes

- 838ba5d: Fix packages publish settings.

## 0.2.0

### Minor Changes

- 0f0ce8f: Initial release.
