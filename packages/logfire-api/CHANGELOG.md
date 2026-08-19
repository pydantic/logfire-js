# @pydantic/logfire-api

## 0.21.10

### Patch Changes

- d55df7a: Stop `Contains` leaving a lone surrogate in a truncated failure reason. The reason string was cut on UTF-16 code units at both ends, so an astral character straddling either boundary lost half of itself, and the resulting reason is not valid UTF-8 once the evaluation result is serialized.
- dcdd0a8: List each evaluator once in the dataset JSON schema. An evaluator that was both registered and passed through `customEvaluators` produced two identical `oneOf` branches, and `oneOf` requires exactly one match, so a dataset file naming that evaluator failed to validate against its own schema.
- 3a1be2e: Treat a null `expected_output` as missing in `EqualsExpected`. A dataset case written with `expected_output: null` produced a failing assertion instead of no assertion, which is what pydantic-evals records and what #219 already settled for the confusion matrix.
- b2d6e2e: Stop recording zero-valued eval metrics that pydantic-evals omits. Span-tree metric extraction now goes through the same increment path as `incrementEvalMetric`, so a provider reporting `gen_ai.usage.cached_tokens: 0` no longer invents a `cached_tokens: 0` metric on the case.
- f3d3427: Stop `instrument` with `recordReturn` rethrowing when the returned value has a throwing `then` getter. Detecting a thenable reads `then`, which runs caller code, so a successful call could surface to the caller as a thrown error and be recorded on the span as a failure. The probe now treats a throwing getter as not thenable.
- 5bfe645: Stop `renderReport` leaving a lone surrogate in a truncated cell. Inputs and outputs were cut on UTF-16 code units at 30, so an astral character straddling that boundary kept only its high half, and the returned report string is no longer valid UTF-8.
- c188c07: Encode an evaluator whose only argument is a list in the long form. `new Equals({ value: [1, 2] })` previously serialized to the short form `{Equals: [1, 2]}`, which reads back as two positional arguments and rebuilt the evaluator with the wrong ones. It now serializes to `{Equals: {value: [1, 2]}}`. Existing files that already contain the short form are unaffected by this change and still decode as positional arguments.
- 487eaa8: Stop `truncateString` splitting a surrogate pair. Truncation cut on UTF-16 code units, so a message value or baggage value long enough to be truncated with an astral character straddling the boundary kept only the high half, leaving a lone surrogate that is not valid UTF-8 once the attribute is serialized. The whole character is dropped instead.

## 0.21.9

### Patch Changes

- 4e0af13: Run the `logfire` CLI when the bin is invoked through a symlink. The entrypoint check compared `import.meta.url` against `process.argv[1]` verbatim, but Node resolves the module URL to the real path while leaving `argv[1]` as the literal invocation path. Any symlink between the two made the check fail, so the command exited 0 without printing anything and without running. `argv[1]` is now resolved before the comparison.

  This affected every install whose invocation path crossed a symlink: `npm install` and Yarn, where the bin itself is a symlink; pnpm with `node-linker=hoisted`; and pnpm workspace links, where the shim points through a symlinked package directory. Only pnpm's default isolated layout and `pnpm add -g` escaped, because their shims target the physical path.

- 4e0af13: Report the correct package version at runtime. `PACKAGE_VERSION` was read from the ambient `npm_package_version` environment variable at build time, which resolves to whichever `package.json` the build was started from. Releases run `pnpm run build` from the repository root, so published artifacts were stamped with the private root version `1.0.0` instead of their own: `logfire@0.21.8` reported `Running Logfire 1.0.0` from `logfire --version` and `logfire info`, and sent `logfire-js/1.0.0` as its CLI user agent. `@pydantic/logfire-browser` reported the same wrong value as the `telemetry.sdk.version` resource attribute on every browser span.

  Each package now reads the version from its own `package.json`, matching what `@pydantic/logfire-node`, `@pydantic/logfire-cf-workers`, and `@pydantic/otel-cf-workers` already did.

## 0.21.8

### Patch Changes

- d6631a8: Keep every entry of an evaluator result map that happens to contain a `value` key. A map such as `{ value: 0.8, confidence: 0.9 }` was read as a single `EvaluationReason`, so it produced one result named after the evaluator and the sibling keys were dropped without warning. A result map and an `EvaluationReason` are now told apart by shape rather than by key names alone: a lone `EvaluationReason` must carry only `value` and `reason`, with a scalar `value` and a string or absent `reason`. Key names by themselves were not enough, because `{ value: 0.8, reason: 0.9 }` is a legal map of scores.
- 099f79b: Honour `LOGFIRE_SEND_TO_LOGFIRE=false`. The environment variable arrives as a string and was passed to `Boolean()`, and `Boolean('false')` is `true`, so the documented way to turn sending off left it on. Setting `sendToLogfire: false` in code was unaffected. `true`, `false` and `if-token-present` are now normalized once and matched explicitly, case-insensitively and trimmed, so a differently cased sentinel no longer falls through to truthiness either.
- 49752da: Stop a pending SSE reconnect backoff from holding a Node process open. The remote variable provider unrefs its polling and debounce timers, but the reconnect backoff used a plain `setTimeout`. That backoff doubles up to a minute while the stream is unreachable, so after `shutdown()` the process could stay alive until it elapsed.

## 0.21.7

### Patch Changes

- 4d4eb0a: Expand references in a referenced variable's value when they follow an even backslash run. The fast-path guard in `expandReferenceSerializedValue` tested the JSON-encoded text with a single-character lookbehind, so any `@{ref}@` preceded by a literal backslash was treated as escaped. A value such as `\\@{inner}@` therefore skipped composition entirely and `inner` was left unexpanded and absent from `composedFrom`, even though the same string expands when it appears at the top level.
- b9783a0: Treat a null `expected_output` as missing in `ConfusionMatrixEvaluator` instead of as a class named `"null"`. A case with no expected output added a phantom row and column to the matrix, while a case with a null `output` was dropped, so the same absent value was counted on one axis and ignored on the other.
- 7c294b8: Report an invalid `Date` in a pushed evaluation dataset as a `DatasetConfigurationError` instead of a bare `RangeError`. `normalizeHostedJsonValue` called `toISOString()` on any `Date`, which throws `RangeError: Invalid time value` for an unparseable one, losing the field, case and path that every other unsupported value reports and bypassing the `serializeValue` hook that can convert it.
- 89a8eba: Stop a throwing `progress` callback from discarding an entire `Dataset.evaluate()` run. The callback ran unguarded inside the `Promise.all` over cases, so one throw rejected `evaluate()` and lost the results of every case that had already finished, along with the report evaluators, analyses, averages and the experiment span's closing attributes. An async callback was worse: its rejection escaped as an unhandled rejection, which terminates the process under Node's default. Progress reporting is now best effort for both, and logs the failure instead.
- a6ee773: Report `PrecisionRecallEvaluator` as not computable when every case shares one class. With only positive cases it returned an AUC of 1, and with only negative cases an AUC of 0, so a dataset that carries no signal read as a perfect or a worthless model. `ROCAUCEvaluator` and `KolmogorovSmirnovEvaluator` already return `NaN` and no curve for the same input.

## 0.21.6

### Patch Changes

- 82eae91: Match Python's `format(value, 'g')` when rendering numeric evaluation values in the `gen_ai.evaluation.result` log body. Values between 1e-6 and 1e-4 now use scientific notation as Python does instead of long fixed-point decimals, a value whose sixth significant digit rounds away no longer emits a stray trailing decimal point (for example `-10515.` for `-10515.04`), and rounding now runs on the binary double with half-to-even ties, so `1 / 512` renders as `0.00195312`, `0.1234555` as `0.123455`, and `Number.MIN_VALUE` as `4.94066e-324`.

## 0.21.5

### Patch Changes

- 33182ce: Match CPython's `repr()` when rendering string evaluation values in the `gen_ai.evaluation.result` log body. Values containing an apostrophe but no double quote now switch to double quotes instead of escaping the apostrophe, and control characters such as newlines and tabs are escaped rather than emitted literally, which previously broke the single-line body across multiple lines.

## 0.21.4

### Patch Changes

- 44cd981: Internal reliability improvements to `LogfireRemoteVariableProvider`:

  - SSE reconnects now immediately fetch fresh config to recover changes missed while the stream was down (first connection is unaffected).
  - Backoff is only reset by SSE-framed lines (comments or named fields), not by arbitrary bytes, preventing a permanent 1 req/s reconnect loop against misbehaving proxies that return short HTTP error bodies.
  - Polling interval uses ±10% uniform jitter to spread load across instances; the freshness guard is adjusted to `0.9 × interval` so jitter-early polls are not silently dropped.
  - Variable fetches use `If-None-Match` / `304 Not Modified` when the server sends an `ETag`, skipping body parsing and config replacement on unchanged responses while still advancing the freshness timestamp.
  - A single 2s debounced follow-up `refresh` is scheduled after each SSE variable event to coalesce bursts and survive short platform cache lag.

## 0.21.3

### Patch Changes

- d2d6461: Fix tail sampling duration for span end events. `TailSamplingSpanInfo.duration` was computed from the span's start time even when the span was ending, so a trace whose slowness happened inside the ending span (for example a root span with no later children) never crossed `durationThreshold` and was dropped. End events now use the span's end time, matching Python Logfire's behavior.

## 0.21.2

### Patch Changes

- 3a9687b: `logfire` now requires `js-yaml >=4.3.0` so consumers resolve the patched YAML merge-key handling.

  `@pydantic/logfire-node` now requires `@opentelemetry/sdk-node >=0.220.0 <0.300.0` so consumers resolve the patched Jaeger propagation dependency while retaining the existing SDK upper bound.

## 0.21.1

### Patch Changes

- f0a67f1: Upgrade the internal dataset validation dependency to Zod 4.

## 0.21.0

### Minor Changes

- 38fb2d4: Expose OpenTelemetry `SpanKind` in the manual span APIs. `span()`, `startSpan()`, `startPendingSpan()`, and `instrument()` accept an optional `kind` that is forwarded to the tracer, and pending span placeholders keep the kind of their real span. Omitting `kind` continues to produce `INTERNAL` spans.

### Patch Changes

- ecdfcf1: Fix nested field access in message templates. `{a.b}` previously resolved every path segment against the top-level attribute record, so it either fell back to the raw template or silently rendered an unrelated top-level attribute that shared the trailing segment name. Nested paths now walk into the attribute value, matching Python Logfire, and literal dotted attribute keys like `http.method` keep their existing precedence. Field lookups now use `Object.hasOwn`, so prototype members like `{user.toString}` no longer resolve. Index-style bracket syntax such as `{a[0]}` was never supported; when no literal attribute key matches, it previously rendered the string `undefined` and now warns and falls back to the raw template. An attribute whose literal key contains brackets (e.g. `'a[0]': value`) keeps resolving, as it did before.

## 0.20.1

### Patch Changes

- 22bd8ec: Add npm bugs metadata for the Logfire package.
- 22bd8ec: Include `Error.cause` chains in recorded exception stacktraces and as structured `exception.cause` attributes.
- ed748fb: Update OpenTelemetry dependency floors to 2.8.0 / 0.219.0 across published packages.

## 0.20.0

### Minor Changes

- 0c0045c: Add managed variable composition and template rendering to `logfire/vars`.

  Variables can now reference other variables with `@{name}@`, expose composition metadata on resolved values, render `{{}}` placeholders through `ResolvedVariable.render()`, and use the new `defineTemplateVar()` / `templateVar` API for compose-and-render prompt/config values. Variable configs also support `template_inputs_schema`, `templateMismatchPolicy`, structured validation diagnostics, strict/non-strict push blocking results, context override composition, and Python-parity fallback behavior for provider values and code defaults. The `logfire/vars/reference-syntax` subpath exposes the browser-safe composition reference parser for UI hints and editor integrations.

## 0.19.0

### Minor Changes

- f4ea331: Add a Node-only `npx logfire` CLI for authentication, project selection/creation, read-token creation, local credential cleanup, `whoami`, and runtime info. The CLI writes Python-compatible global auth tokens and local `.logfire/logfire_credentials.json` project credentials.

  `@pydantic/logfire-node` now reads local project credentials when no explicit token and no `LOGFIRE_TOKEN` are configured, while browser and worker packages remain credential-file free.

## 0.18.0

### Minor Changes

- b0661cd: Add a hosted datasets API client for managing Logfire datasets and cases from trusted JavaScript runtimes.

  The core client is available from `logfire/datasets` with explicit API-key configuration. Node.js applications can use `@pydantic/logfire-node/datasets` for a helper that reads `LOGFIRE_API_KEY` and `LOGFIRE_BASE_URL`. The evaluation dataset bridge is covered by the companion hosted evaluation datasets changeset.

- b0661cd: Add high-level hosted evaluation dataset helpers for pushing local eval datasets to Logfire and fetching hosted datasets back into executable local `Dataset` instances.

## 0.17.0

### Minor Changes

- 45c545d: Add opt-in baggage projection for Logfire JS manual span attributes.
- 45c545d: Add a core `instrument(fn, options?)` wrapper for manual function spans.
- 45c545d: Add richer bounded JSON schema metadata for serialized object and array attributes, with `jsonSchema` modes for rich, legacy broad, or disabled schema metadata.
- 45c545d: Add configurable minimum-level filtering for manual Logfire telemetry.
- 45c545d: Add `reportError()` options for tags and parent spans, and allow reporting unknown caught values.
- 45c545d: Add scoped manual API clients with `withTags()` and `withSettings()` for reusable tags and default levels.

## 0.16.0

### Minor Changes

- db97858: Add a shared `PendingSpanProcessor` and enable Node to emit pending spans for non-tail-sampled Logfire spans.

### Patch Changes

- db97858: Enable pending spans for tail-sampled Node traces without exporting pending placeholders for dropped traces.
- db97858: Add a shared `startPendingSpan()` helper for explicit pending placeholders without enabling automatic Browser pending spans.

## 0.15.2

### Patch Changes

- 585db46: Broaden OpenTelemetry 0.x catalog ranges so consumers can resolve patched OTel minors between Logfire releases.

## 0.15.1

### Patch Changes

- 0a41b45: Update OpenTelemetry peer dependency ranges to the latest JS releases, including the patched Node SDK and auto-instrumentation versions for GHSA-q7rr-3cgh-j5r3.

## 0.15.0

### Minor Changes

- 08ecf7f: Add managed variables support through the `logfire/vars` subpath, including local and remote providers, async variable resolution, targeting contexts, overrides, config validation, and push/pull helpers. Node configuration now supports `apiKey`, `LOGFIRE_API_KEY`, and managed variable provider configuration.

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
