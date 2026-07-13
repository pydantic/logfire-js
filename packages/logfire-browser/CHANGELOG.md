# @pydantic/logfire-browser

## 0.17.0

### Minor Changes

- 6760a47: Stabilize browser RUM lifecycle setup with deferred instrumentation factories, opt-in lazy `autoInstrumentations`, provider-owned Web Vitals spans, explicit page URL attributes, and clarified session replay correlation semantics.
- 6760a47: Add opt-in browser RUM session identity and custom span processor configuration.
- 6760a47: Add opt-in native OpenTelemetry histogram metrics for browser Web Vitals. Configure top-level `metrics.metricUrl` and `rum.webVitals.metrics` to emit LCP, INP, CLS, FCP, and TTFB metrics in parallel with existing Web Vital spans.
- 6760a47: Add opt-in browser RUM Web Vitals reporting with `rum.webVitals`, emitting LCP, INP, CLS, FCP, and TTFB as Logfire spans with attribution fields.
- 6760a47: Add opt-in browser `sessionReplay` integration with SDK-owned session correlation, replay state span attributes, optional peer loading, telemetry endpoint suppression, and live replay mode reporting.

### Patch Changes

- 6760a47: Preserve callable browser cleanup while exposing generation-scoped session replay lifecycle controls, keep Web Vitals spans available when metrics startup fails, and mark Web Vitals point events as Logfire logs.

  Remove unused pre-stable replay transport, recorder snapshot, and navigation `load` surfaces that were never used or emitted.

- 6760a47: Make same-page browser reconfiguration deterministic and ownership-safe. Cached tracers and manual Logfire APIs now follow each sequential provider generation, inactive intervals are non-recording, overlapping configurations fail explicitly, and cleanup preserves application-owned OpenTelemetry globals.
- 6760a47: Document safer development proxy examples and clarify that the Python telemetry helpers do not forward browser replay uploads.
- 6760a47: Use privacy-safe browser defaults: omit query strings and fragments from page
  attributes and replay URLs, mask rendered replay text, and disable replay
  console capture unless explicitly enabled.
- 6760a47: Harden browser RUM and session replay for their stable releases with transactional replay lifecycle handling, per-session sampling, retry-safe optional instrumentation, and finalized page URL and error-promotion contracts.
- Updated dependencies [6760a47]
- Updated dependencies [6760a47]
- Updated dependencies [6760a47]
- Updated dependencies [6760a47]
- Updated dependencies [6760a47]
- Updated dependencies [6760a47]
  - @pydantic/logfire-session-replay@0.1.0

## 0.17.0-alpha.2

### Minor Changes

- Stabilize browser RUM lifecycle setup with deferred instrumentation factories, opt-in lazy `autoInstrumentations`, provider-owned Web Vitals spans, explicit page URL attributes, and clarified session replay correlation semantics.

## 0.17.0-alpha.1

### Patch Changes

- Updated dependencies
  - @pydantic/logfire-session-replay@0.1.0-alpha.1

## 0.17.0-alpha.0

### Minor Changes

- fc8277f: Add opt-in browser RUM session identity and custom span processor configuration.
- fc8277f: Add opt-in native OpenTelemetry histogram metrics for browser Web Vitals. Configure top-level `metrics.metricUrl` and `rum.webVitals.metrics` to emit LCP, INP, CLS, FCP, and TTFB metrics in parallel with existing Web Vital spans.
- fc8277f: Add opt-in browser RUM Web Vitals reporting with `rum.webVitals`, emitting LCP, INP, CLS, FCP, and TTFB as Logfire spans with attribution fields.
- 63ccc9d: Add opt-in browser `sessionReplay` integration with SDK-owned session correlation, replay state span attributes, optional peer loading, telemetry endpoint suppression, and live replay mode reporting.

### Patch Changes

- Updated dependencies [63ccc9d]
- Updated dependencies [98118c3]
  - @pydantic/logfire-session-replay@0.1.0-alpha.0

## 0.16.4

### Patch Changes

- ed748fb: Update OpenTelemetry dependency floors to 2.8.0 / 0.219.0 across published packages.
- Updated dependencies [22bd8ec]
- Updated dependencies [22bd8ec]
- Updated dependencies [ed748fb]
  - logfire@0.20.1

## 0.16.3

### Patch Changes

- Updated dependencies [0c0045c]
  - logfire@0.20.0

## 0.16.2

### Patch Changes

- Updated dependencies [f4ea331]
  - logfire@0.19.0

## 0.16.1

### Patch Changes

- Updated dependencies [b0661cd]
- Updated dependencies [b0661cd]
  - logfire@0.18.0

## 0.16.0

### Minor Changes

- 45c545d: Add scoped manual API clients with `withTags()` and `withSettings()` for reusable tags and default levels.

### Patch Changes

- 45c545d: Add opt-in baggage projection for Logfire JS manual span attributes.
- 45c545d: Add a core `instrument(fn, options?)` wrapper for manual function spans.
- 45c545d: Add richer bounded JSON schema metadata for serialized object and array attributes, with `jsonSchema` modes for rich, legacy broad, or disabled schema metadata.
- 45c545d: Add configurable minimum-level filtering for manual Logfire telemetry.
- 45c545d: Add `reportError()` options for tags and parent spans, and allow reporting unknown caught values.
- Updated dependencies [45c545d]
- Updated dependencies [45c545d]
- Updated dependencies [45c545d]
- Updated dependencies [45c545d]
- Updated dependencies [45c545d]
- Updated dependencies [45c545d]
  - logfire@0.17.0

## 0.15.3

### Patch Changes

- db97858: Make Browser cleanup safe to call repeatedly by sharing one cleanup promise, preserving cleanup order, and avoiding hidden retries after failure.
- db97858: Add a shared `startPendingSpan()` helper for explicit pending placeholders without enabling automatic Browser pending spans.
- Updated dependencies [db97858]
- Updated dependencies [db97858]
- Updated dependencies [db97858]
  - logfire@0.16.0

## 0.15.2

### Patch Changes

- 585db46: Broaden OpenTelemetry 0.x catalog ranges so consumers can resolve patched OTel minors between Logfire releases.
- Updated dependencies [585db46]
  - logfire@0.15.2

## 0.15.1

### Patch Changes

- 0a41b45: Update OpenTelemetry peer dependency ranges to the latest JS releases, including the patched Node SDK and auto-instrumentation versions for GHSA-q7rr-3cgh-j5r3.
- Updated dependencies [0a41b45]
  - logfire@0.15.1

## 0.15.0

### Minor Changes

- 08c513d: Add a typed `resourceAttributes` configure option for setting stable OpenTelemetry resource attributes without using `OTEL_RESOURCE_ATTRIBUTES`.

### Patch Changes

- Updated dependencies [08ecf7f]
  - logfire@0.15.0

## 0.14.3

### Patch Changes

- Updated dependencies [b6e76c2]
  - logfire@0.14.0

## 0.14.2

### Patch Changes

- 51f8ad5: Upgrade the published OpenTelemetry dependency ranges to patched versions and move
  the Cloudflare workers integration to `@pydantic/otel-cf-workers@1.0.0-rc.55`.
- Updated dependencies [51f8ad5]
  - logfire@0.13.2

## 0.14.1

### Patch Changes

- Updated dependencies [894cf8e]
  - logfire@0.13.1

## 0.14.0

### Minor Changes

- 1b4d704: Add trace sampling support (head + tail)

  Implements a two-layer sampling system matching the Python SDK:

  - Head sampling: probabilistic sampling at trace creation via `ParentBasedSampler`
  - Tail sampling: callback-based sampling with span buffering via `TailSamplingProcessor`
  - `SamplingOptions` type, `SpanLevel` class, `checkTraceIdRatio`, and `levelOrDuration` factory in `logfire-api`
  - `LOGFIRE_TRACE_SAMPLE_RATE` env var support in `logfire-node`

### Patch Changes

- Updated dependencies [1b4d704]
  - logfire@0.13.0

## 0.13.0

### Minor Changes

- 56f5bbb: Add `errorFingerprinting` configuration option to control error fingerprint computation

  Error fingerprinting enables grouping similar errors in the Logfire backend. However, minified browser code produces unstable fingerprints because function names are mangled, causing the same logical error to generate different fingerprints across deployments.

  - Added `errorFingerprinting` option to `LogfireApiConfigOptions`
  - Browser SDK now defaults to `errorFingerprinting: false`
  - Node SDK keeps the default `errorFingerprinting: true`
  - Users can override the default in either SDK via the `configure()` options

### Patch Changes

- Updated dependencies [56f5bbb]
  - logfire@0.12.0

## 0.12.3

### Patch Changes

- eeb5801: Update OpenTelemetry dependencies to latest versions

## 0.12.2

### Patch Changes

- 0420b0e: Fix phantom dependency

## 0.12.1

### Patch Changes

- 06fa5d8: Fix logfire-dependency

## 0.12.0

### Minor Changes

- 26db714: Use logfire instead of @pydantic/logfire-api

## 0.11.0

### Minor Changes

- 00ffa94: Use logfire instead of @pydantic/logfire-api

## 0.10.0

### Minor Changes

- 03df4fb: Add default export to packages. Using the default import is equivalent to the star import.

### Patch Changes

- Updated dependencies [03df4fb]
  - @pydantic/logfire-api@0.9.0

## 0.9.1

### Patch Changes

- 258969c: Update READMEs

## 0.9.0

### Minor Changes

- 413ff56: Support logging spans in the console

## 0.8.1

### Patch Changes

- 4c22f71: Externalize the context manager, to avoid zone.js patching
- Updated dependencies [4c22f71]
  - @pydantic/logfire-api@0.8.1

## 0.8.0

### Minor Changes

- f29a18b: Support Zone.js promises

### Patch Changes

- Updated dependencies [f29a18b]
  - @pydantic/logfire-api@0.8.0

## 0.7.0

### Minor Changes

- 2771f37: Support dynamic headers for the proxy URL

## 0.6.0

### Minor Changes

- 763b96a: Improve fetch / click spans

## 0.5.0

### Minor Changes

- 71f46db: Auto-close spans opened with logfire.span

### Patch Changes

- Updated dependencies [71f46db]
  - @pydantic/logfire-api@0.6.0

## 0.4.0

### Minor Changes

- 4d22a69: Support configuration for the trace exporter config

## 0.3.1

### Patch Changes

- 9bab4b9: Add the missing dependency

## 0.3.0

### Minor Changes

- 088af0d: Support environment configuration

## 0.2.0

### Minor Changes

- 478e045: Experimental browser support

### Patch Changes

- 54351e7: Add browser resource attributes
- Updated dependencies [478e045]
  - @pydantic/logfire-api@0.5.0
