# @pydantic/logfire-api

## 0.14.0

### Minor Changes

- b6e76c2: Add evals support — offline + online evaluations.

  A new `logfire/evals` subpath exports `Dataset`, `Case`, `Evaluator`, built-in evaluators (`Equals`, `EqualsExpected`, `Contains`, `IsInstance`, `MaxDuration`, `HasMatchingSpan`, `LLMJudge`), report-level evaluators (`ConfusionMatrixEvaluator`, `PrecisionRecallEvaluator`, `ROCAUCEvaluator`, `KolmogorovSmirnovEvaluator`), and `withOnlineEvaluation` for runtime monitoring.

  Emitted OTel spans, log events, and report analyses are wire-compatible with the Python `pydantic-evals` package, so experiments, cases, report-level charts, and live evaluations show up automatically in the Logfire web UI without any additional configuration. Datasets serialize to / deserialize from the same YAML and JSON format Python uses (`Dataset.toFile` / `Dataset.fromFile`, `Dataset.jsonSchema()`), with filesystem helpers supported in Node, Bun, and Deno.

  `logfire.configure()` now auto-installs the evals span-tree processor; users on a custom `TracerProvider` can install it manually with `getEvalsSpanProcessor()` from `logfire/evals`.

## 0.13.2

### Patch Changes

- 51f8ad5: Upgrade the published OpenTelemetry dependency ranges to patched versions and move
  the Cloudflare workers integration to `@pydantic/otel-cf-workers@1.0.0-rc.55`.

## 0.13.1

### Patch Changes

- 894cf8e: Record exceptions on spans when callbacks throw or reject

  `span()` now automatically records exception details (event, ERROR status, log level, fingerprint) when the callback throws synchronously or the returned promise rejects, matching the Python SDK's behavior.

## 0.13.0

### Minor Changes

- 1b4d704: Add trace sampling support (head + tail)

  Implements a two-layer sampling system matching the Python SDK:
  - Head sampling: probabilistic sampling at trace creation via `ParentBasedSampler`
  - Tail sampling: callback-based sampling with span buffering via `TailSamplingProcessor`
  - `SamplingOptions` type, `SpanLevel` class, `checkTraceIdRatio`, and `levelOrDuration` factory in `logfire-api`
  - `LOGFIRE_TRACE_SAMPLE_RATE` env var support in `logfire-node`

## 0.12.0

### Minor Changes

- 56f5bbb: Add `errorFingerprinting` configuration option to control error fingerprint computation

  Error fingerprinting enables grouping similar errors in the Logfire backend. However, minified browser code produces unstable fingerprints because function names are mangled, causing the same logical error to generate different fingerprints across deployments.
  - Added `errorFingerprinting` option to `LogfireApiConfigOptions`
  - Browser SDK now defaults to `errorFingerprinting: false`
  - Node SDK keeps the default `errorFingerprinting: true`
  - Users can override the default in either SDK via the `configure()` options

## 0.11.1

### Patch Changes

- 9f03df2: Fix phantom dependencies

## 0.11.0

### Minor Changes

- 28eb056: BREAKING CHANGE: Package renamed from `@pydantic/logfire-api` to `logfire`.

  This change makes the core API package easier to use with a simpler, unscoped name.

  **Migration Guide**:
  - Update package.json: Change `"@pydantic/logfire-api"` to `"logfire"`
  - Update imports: Change `from '@pydantic/logfire-api'` to `from 'logfire'`
  - Run `npm install` to update lockfiles

  The package functionality remains identical. This is purely a naming change.

  **Why this change?**
  The core API package is used across all runtimes (Node, browser, Cloudflare Workers) and deserves the simpler package name. The Node.js-specific SDK with auto-instrumentation is now `@pydantic/logfire-node`.

## 0.9.0

### Minor Changes

- 03df4fb: Add default export to packages. Using the default import is equivalent to the star import.

## 0.8.2

### Patch Changes

- 8c57b16: Do not format span_name

## 0.8.1

### Patch Changes

- 4c22f71: Externalize the context manager, to avoid zone.js patching

## 0.8.0

### Minor Changes

- f29a18b: Support Zone.js promises

## 0.7.0

### Minor Changes

- 2f2f859: Improve nested span API
  - Add convenient 2 argument overload for `span`.
  - Support `parentSpan` option to nest spans manually.

## 0.6.1

### Patch Changes

- 421b666: Fix async parent span timing

## 0.6.0

### Minor Changes

- 71f46db: Auto-close spans opened with logfire.span

## 0.5.0

### Minor Changes

- 478e045: Experimental browser support

## 0.4.2

### Patch Changes

- fac89ec: logfire.reportError - documentation and setting correct span type
- fac89ec: Document and slightly enhance the `reportError` function.

## 0.4.1

### Patch Changes

- cd2ac40: Fix attribute serialization

## 0.4.0

### Minor Changes

- dc0a537: Support for EU tokens. Support span message formatting.

## 0.3.0

### Minor Changes

- 6fa1410: API updates, fixes for span kind

## 0.2.1

### Patch Changes

- 838ba5d: Fix packages publish settings.

## 0.2.0

### Minor Changes

- 0f0ce8f: Initial release.
