# @pydantic/logfire-api

## 0.22.4

### Patch Changes

- 2226a59: Count a score, metric or label named `__proto__`, and a label value of `__proto__`, in report averages. Those names come from evaluator output and were assigned into plain objects, so the inherited `__proto__` setter swallowed them: the bucket disappeared and the remaining label values were renormalised as if it had never existed. The aggregation code now tallies through a shared `Map`-backed accumulator, so every key is stored as an own property.

## 0.22.3

### Patch Changes

- 8f6c307: Generate a dataset JSON Schema that matches the evaluator forms the loader accepts. The schema only described `{Name: {kwargs}}`, so the short form `{Equals: 1}` that `Dataset.toText`/`toObject` writes failed validation in an editor, while a bare `Equals` validated even though constructing it with no arguments throws.
- 8e2d6b3: Round-trip the `EqualsExpected` evaluation name and let `Dataset.jsonSchema()` receive `primaryArgKeys`. `{EqualsExpected: 'x'}` decoded through the positional path and silently dropped the name (Python's dataclass accepts it positionally), and the instance schema API could not express the primary-arg option that `fromObject` already honours.
- 00c584f: Keep online-evaluation sinks running when OTel emission fails for one evaluator. Emission ran unguarded before the sinks, so an evaluator whose spec could not be JSON-serialized threw out of the whole dispatch: the other evaluators' results never reached the sink, and the configured `onError` was never called because the dispatch promise is discarded.
- 396b738: Report a failing online-evaluation sink through the `onError` configured on each evaluator. Evaluators that share a sink are batched into one submit call, and the batch resolved a single handler from the first evaluator, so a handler set on any other evaluator in the batch never fired. The same resolution applies on the default-sink path, where a per-evaluator handler was skipped in favour of the config-level one.
- bf2df6d: Keep `TailSamplingProcessor` trace state until the root has ended and every started span has ended, so a span still running when the root closes is no longer exported unconditionally through the unbuffered path. This is a deliberate divergence from the Python SDK, which pops the buffer at root end and passes late spans through, bounding memory by accepting that behaviour; the upstream side is tracked in pydantic/logfire#2273. Two consequences of the longer lifetime: a late span in a sampled trace now reaches the deferred processor rather than only the wrapped one, and a late span can still flip a trace to sampled after its root ended below a duration threshold, replaying the whole trace. Retention past root end is capped at 1000 traces, after which the oldest degrades to the previous passthrough behaviour rather than pinning memory.
- a8d2736: Match OTel's exclusive TraceIdRatioBasedSampler bound in `checkTraceIdRatio`. An accumulation equal to `floor(rate * 0xffffffff)` was sampled; the OTel JS sampler's comparison is `<`, so the 0.5 threshold ID `7fffffff` followed by 24 zeros is now dropped.

## 0.22.2

### Patch Changes

- b334f97: Stop dropping a baggage entry whose key names an inherited object member. `applyBaggage` tested for a conflict with `in`, so a `baggage` header carrying `toString` or `constructor` had that entry silently left off the emitted `gen_ai.evaluation.result` event.
- 4ced7fe: Reject an option value that is really the next flag in every CLI command. `read-tokens` already refused it, but the global options, `whoami`, `projects` and `clean` each had their own copy of the check without that guard, so `logfire clean --data-dir --logs` took `--logs` as the directory name and silently dropped the flag. The four copies are gone; there is one shared helper.
- df17ff9: Keep an own `__proto__` key when normalizing values for `pushEvaluationDataset`. Assigning into a plain object invoked the `__proto__` setter instead of creating a property, so a JSON-parsed case value carrying that key had it silently dropped from the pushed dataset.
- 3d5c543: Compare the contents of Dates, RegExps, Sets and Maps in the `Equals` and `EqualsExpected` evaluators. `deepEqual` only compared own enumerable keys, and those types keep their contents in internal slots, so any two of them matched each other and a wrong `Date` passed as equal to the expected one.
- 320d760: Omit `gen_ai.evaluation.explanation` on an evaluator failure that carries no message, instead of emitting an empty string. pydantic-evals leaves the attribute off in that case, so a failure from `throw new Error()` no longer records an explanation that is not one.
- 8ee48bd: Identify the V8 stack header by matching the error's own name and message, so a message containing a frame-shaped `x@y:1:2` no longer leaks into the exception fingerprint as a fake frame.
- c07dbea: Keep the top stack frame when fingerprinting an error in Firefox or Safari. Frame parsing dropped the first line of `error.stack` to skip V8's `Error: message` header, but those engines have no header line, so the frame that identifies the error was discarded and two unrelated errors sharing the frame below it received the same `logfire.exception.fingerprint`.
- ba8fe33: Read `LOGFIRE_SEND_TO_LOGFIRE=0` and `f` as disabled instead of falling through to string truthiness, matching the boolean spellings the Python SDK accepts.
- 9c6538e: Match structured attributes in span queries. `hasAttributes` compared the span attribute with `===`, so a query for an object or an array never matched: OTel carries an object as the JSON string `serializeAttributes` wrote, and an array as a real array, and neither is `===` a fresh query value. `HasMatchingSpan` and `SpanTree.any`/`find`/`first` now compare structurally and decode a JSON string attribute first, the way pydantic-evals does.
- 83cf913: Stop reporting item fields inside an `each` or `with` block as missing template inputs. `variablesValidate` collected bare paths from a block body and checked them against the root `templateInputsSchema`, so `{{#each items}}{{name}}{{/each}}` was flagged for `name` even though the template renders correctly.
- eca8805: Record the exception on the span when a zone.js-style promise returned from a `span()` callback rejects. Native promise rejections already recorded the error and set the span status to `ERROR`, but the zone.js branch only ended the span, so in Angular applications a failing span looked successful and carried no exception.
- cd89805: Record the failure on the span when a zone.js-style thenable's `then` throws before any settlement handler runs, instead of ending the span with an OK status.

## 0.22.1

### Patch Changes

- 6a44751: Report an evaluator failure when a case evaluator returns `NaN` or `Infinity` instead of recording it as a score. A single non-finite score made the mean for that key `NaN` across the whole experiment, and pydantic-evals rejects these values outright.

## 0.22.0

### Minor Changes

- 4962803: Add `logfire projects status` to show what telemetry has actually reached the linked project, one row per service. It reads a read token saved by the new `logfire read-tokens create --save`, which stores the token in `.logfire/read_token.json` instead of printing it, so verifying your own setup never puts a token in a terminal, a CI log, or an agent's transcript.

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
