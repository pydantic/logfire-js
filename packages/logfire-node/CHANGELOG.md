# logfire

## 0.18.8

### Patch Changes

- 59a6682: Fix `distributedTracing` precedence in Node `configure()`. An explicit `distributedTracing: false` was overridden by `LOGFIRE_DISTRIBUTED_TRACING=true`, while an explicit `true` correctly won over the environment. The code option now always wins, matching every other configure() setting, and an empty `LOGFIRE_DISTRIBUTED_TRACING` value is treated as unset instead of disabling distributed tracing.
- 13b5ee7: Send a `logfire-js/<version>` User-Agent when exporting traces, logs, and metrics. The Cloudflare Workers OTLP exporter now sends a default `otel-cf-workers/<version>` identifier and accepts a `userAgent` option that is prepended to it.
- Updated dependencies [d2d6461]
  - logfire@0.21.3

## 0.18.7

### Patch Changes

- 3a9687b: `logfire` now requires `js-yaml >=4.3.0` so consumers resolve the patched YAML merge-key handling.

  `@pydantic/logfire-node` now requires `@opentelemetry/sdk-node >=0.220.0 <0.300.0` so consumers resolve the patched Jaeger propagation dependency while retaining the existing SDK upper bound.

- Updated dependencies [3a9687b]
  - logfire@0.21.2

## 0.18.6

### Patch Changes

- Updated dependencies [f0a67f1]
  - logfire@0.21.1

## 0.18.5

### Patch Changes

- Updated dependencies [ecdfcf1]
- Updated dependencies [38fb2d4]
  - logfire@0.21.0

## 0.18.4

### Patch Changes

- 4a9df3d: Make repeated `configure()` calls — and `configure()` after `shutdown()` — deterministically replace the active SDK. Previously the OpenTelemetry API silently refused the new global registration, so every emission stayed pinned to the first configuration and went dark once it shut down, most visibly under HMR-style dev servers that re-run the entry module (#167). Teardown now unregisters the API globals logfire owns, disables superseded instrumentations, and re-fetches the shared tracer. Also fixed: `shutdown()` and `forceFlush()` no longer hang for 30 seconds when `sendToLogfire` is false and spans are buffered.

## 0.18.3

### Patch Changes

- ce8c66f: Support both legacy and options-object BatchLogRecordProcessor constructor shapes across OpenTelemetry SDK logs releases.

## 0.18.2

### Patch Changes

- ed748fb: Update OpenTelemetry dependency floors to 2.8.0 / 0.219.0 across published packages.
- Updated dependencies [22bd8ec]
- Updated dependencies [22bd8ec]
- Updated dependencies [ed748fb]
  - logfire@0.20.1

## 0.18.1

### Patch Changes

- Updated dependencies [0c0045c]
  - logfire@0.20.0

## 0.18.0

### Minor Changes

- f4ea331: Add a Node-only `npx logfire` CLI for authentication, project selection/creation, read-token creation, local credential cleanup, `whoami`, and runtime info. The CLI writes Python-compatible global auth tokens and local `.logfire/logfire_credentials.json` project credentials.

  `@pydantic/logfire-node` now reads local project credentials when no explicit token and no `LOGFIRE_TOKEN` are configured, while browser and worker packages remain credential-file free.

### Patch Changes

- Updated dependencies [f4ea331]
  - logfire@0.19.0

## 0.17.0

### Minor Changes

- b0661cd: Add a hosted datasets API client for managing Logfire datasets and cases from trusted JavaScript runtimes.

  The core client is available from `logfire/datasets` with explicit API-key configuration. Node.js applications can use `@pydantic/logfire-node/datasets` for a helper that reads `LOGFIRE_API_KEY` and `LOGFIRE_BASE_URL`. The evaluation dataset bridge is covered by the companion hosted evaluation datasets changeset.

- b0661cd: Add high-level hosted evaluation dataset helpers for pushing local eval datasets to Logfire and fetching hosted datasets back into executable local `Dataset` instances.

### Patch Changes

- Updated dependencies [b0661cd]
- Updated dependencies [b0661cd]
  - logfire@0.18.0

## 0.16.0

### Minor Changes

- 45c545d: Add Node object-style console output options for minimum level, tags, and timestamps.

  `console: true` and `LOGFIRE_CONSOLE=true` now use an `info` console minimum by default. Use `console: { minLevel: 'debug' }`
  or `console: { minLevel: 'trace' }` to print lower-severity output locally.

### Patch Changes

- 45c545d: Add opt-in baggage projection for Logfire JS manual span attributes.
- 45c545d: Add a core `instrument(fn, options?)` wrapper for manual function spans.
- 45c545d: Add richer bounded JSON schema metadata for serialized object and array attributes, with `jsonSchema` modes for rich, legacy broad, or disabled schema metadata.
- 45c545d: Add configurable minimum-level filtering for manual Logfire telemetry.
- 45c545d: Read `OTEL_SERVICE_NAME` and `OTEL_SERVICE_VERSION` as Node service metadata fallbacks when the corresponding `LOGFIRE_*`
  environment variables are unset.
- 45c545d: Add `reportError()` options for tags and parent spans, and allow reporting unknown caught values.
- 45c545d: Add scoped manual API clients with `withTags()` and `withSettings()` for reusable tags and default levels.
- Updated dependencies [45c545d]
- Updated dependencies [45c545d]
- Updated dependencies [45c545d]
- Updated dependencies [45c545d]
- Updated dependencies [45c545d]
- Updated dependencies [45c545d]
  - logfire@0.17.0

## 0.15.4

### Patch Changes

- db97858: Enable pending spans for tail-sampled Node traces without exporting pending placeholders for dropped traces.
- db97858: Make Node SDK process handlers safe and bounded under signal/error termination.
- db97858: Improve Node lifecycle flushing so `forceFlush()` and `shutdown()` cover all Logfire-managed span, log, evaluation, metric-reader, and additional span processor paths.
- db97858: Add a shared `startPendingSpan()` helper for explicit pending placeholders without enabling automatic Browser pending spans.
- db97858: Add a shared `PendingSpanProcessor` and enable Node to emit pending spans for non-tail-sampled Logfire spans.
- Updated dependencies [db97858]
- Updated dependencies [db97858]
- Updated dependencies [db97858]
  - logfire@0.16.0

## 0.15.3

### Patch Changes

- 585db46: Broaden OpenTelemetry 0.x catalog ranges so consumers can resolve patched OTel minors between Logfire releases.
- Updated dependencies [585db46]
  - logfire@0.15.2

## 0.15.2

### Patch Changes

- 0a41b45: Update OpenTelemetry peer dependency ranges to the latest JS releases, including the patched Node SDK and auto-instrumentation versions for GHSA-q7rr-3cgh-j5r3.
- Updated dependencies [0a41b45]
  - logfire@0.15.1

## 0.15.1

### Patch Changes

- b5300a9: Support async token providers for rotating authorization headers in Node.js.

## 0.15.0

### Minor Changes

- 08ecf7f: Add managed variables support through the `logfire/vars` subpath, including local and remote providers, async variable resolution, targeting contexts, overrides, config validation, and push/pull helpers. Node configuration now supports `apiKey`, `LOGFIRE_API_KEY`, and managed variable provider configuration.
- 08c513d: Add a typed `resourceAttributes` configure option for setting stable OpenTelemetry resource attributes without using `OTEL_RESOURCE_ATTRIBUTES`.

### Patch Changes

- Updated dependencies [08ecf7f]
  - logfire@0.15.0

## 0.14.0

### Minor Changes

- b6e76c2: Add evals support — offline + online evaluations.

  A new `logfire/evals` subpath exports `Dataset`, `Case`, `Evaluator`, built-in evaluators (`Equals`, `EqualsExpected`, `Contains`, `IsInstance`, `MaxDuration`, `HasMatchingSpan`, `LLMJudge`), report-level evaluators (`ConfusionMatrixEvaluator`, `PrecisionRecallEvaluator`, `ROCAUCEvaluator`, `KolmogorovSmirnovEvaluator`), and `withOnlineEvaluation` for runtime monitoring.

  Emitted OTel spans, log events, and report analyses are wire-compatible with the Python `pydantic-evals` package, so experiments, cases, report-level charts, and live evaluations show up automatically in the Logfire web UI without any additional configuration. Datasets serialize to / deserialize from the same YAML and JSON format Python uses (`Dataset.toFile` / `Dataset.fromFile`, `Dataset.jsonSchema()`), with filesystem helpers supported in Node, Bun, and Deno.

  `logfire.configure()` now auto-installs the evals span-tree processor; users on a custom `TracerProvider` can install it manually with `getEvalsSpanProcessor()` from `logfire/evals`.

### Patch Changes

- Updated dependencies [b6e76c2]
  - logfire@0.14.0

## 0.13.2

### Patch Changes

- 51f8ad5: Upgrade the published OpenTelemetry dependency ranges to patched versions and move
  the Cloudflare workers integration to `@pydantic/otel-cf-workers@1.0.0-rc.55`.
- Updated dependencies [51f8ad5]
  - logfire@0.13.2

## 0.13.1

### Patch Changes

- Updated dependencies [894cf8e]
  - logfire@0.13.1

## 0.13.0

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

## 0.12.0

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

## 0.11.6

### Patch Changes

- de8687b: Fix OpenTelemetry peer dependency conflict by upgrading to 0.210.x versions

  The previous configuration declared `@opentelemetry/auto-instrumentations-node@^0.67.0` alongside `@opentelemetry/sdk-node@^0.209.0`, which are incompatible because auto-instrumentations-node@0.67.x requires sdk-node@^0.208.0 internally. Updated all conflicting peer dependencies to 0.210.x to align with auto-instrumentations-node@0.68.0.

## 0.11.5

### Patch Changes

- c9a5685: Fix broken dependency reference in published package (logfire was incorrectly published as "workspace:\*")

## 0.11.4

### Patch Changes

- eeb5801: Update OpenTelemetry dependencies to latest versions

## 0.11.3

### Patch Changes

- 9f03df2: Fix phantom dependencies
- Updated dependencies [9f03df2]
  - logfire@0.11.1

## 0.11.2

### Patch Changes

- 79032ef: Fix Scrubbing configuration. Scrubbing now works even when scope is not set

## 0.11.1

### Patch Changes

- 26db714: Fix publish

## 0.11.0

### Minor Changes

- 28eb056: BREAKING CHANGE: Package renamed from `logfire` to `@pydantic/logfire-node`.

  This change clarifies that this package is the Node.js-specific SDK with OpenTelemetry auto-instrumentation.

  **Migration Guide**:

  - Update package.json: Change `"logfire"` to `"@pydantic/logfire-node"`
  - Update imports: Change `from 'logfire'` to `from '@pydantic/logfire-node'`
  - Run `npm install` to update lockfiles

  The package functionality remains identical. This is purely a naming change.

  **Why this change?**
  The core API package (now simply called `logfire`) is used across all runtimes. The Node.js SDK with auto-instrumentation is a more specialized package and should have a scoped, descriptive name.

### Patch Changes

- Updated dependencies [28eb056]
  - logfire@0.11.0

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

## 0.8.0

### Minor Changes

- 71f46db: Auto-close spans opened with logfire.span

### Patch Changes

- Updated dependencies [71f46db]
  - @pydantic/logfire-api@0.6.0

## 0.7.0

### Minor Changes

- 2a62de6: Support passing additional instrumentations

## 0.6.0

### Minor Changes

- 478e045: Experimental browser support

### Patch Changes

- Updated dependencies [478e045]
  - @pydantic/logfire-api@0.5.0

## 0.5.2

### Patch Changes

- cd2ac40: Fix attribute serialization
- Updated dependencies [cd2ac40]
  - @pydantic/logfire-api@0.4.1

## 0.5.1

### Patch Changes

- 14833ef: Fix typo in interface name

## 0.5.0

### Minor Changes

- e1dc8d0: Allow configuration of node auto instrumentations

## 0.4.1

### Patch Changes

- 8dbb603: Fix for not picking up environment

## 0.4.0

### Minor Changes

- dc0a537: Support for EU tokens. Support span message formatting.
- 65274e3: Support us/eu tokens

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

- a391811: Fix for a peer package

## 0.2.1

### Patch Changes

- 838ba5d: Fix packages publish settings.
- Updated dependencies [838ba5d]
  - @pydantic/logfire-api@0.2.1

## 0.2.0

### Minor Changes

- 0f0ce8f: Initial release.

### Patch Changes

- Updated dependencies [0f0ce8f]
  - @pydantic/logfire-api@0.2.0
