# @pydantic/logfire-browser

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
