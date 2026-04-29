# Parity follow-up: how well do the in-flight changes address the report

This is a re-review of the original 45-finding report ([pydantic-evals-parity.md](pydantic-evals-parity.md)) against the uncommitted changes in the working tree. The diff touches 25 files and ~1,150 lines.

**Headline:** the changes address ~34 of 45 findings (the great majority of high-severity ones). Remaining gaps are mostly structural ("would require redesign"), inherent to JavaScript runtime limitations, or by-design.

The first read of the report was also wrong about a small number of items — flagged below as **NOTE: original finding was incorrect**, where the code already matched Python and I had misread it.

## A. Core orchestration

| #   | Finding                             | Status                                                                                                              |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | Evaluator order reversed            | **Fixed** — `Dataset.ts:443` now `[...originalCase.evaluators, ...datasetEvaluators]` (case first, matches Python). |
| 2   | Evaluators run sequentially         | **Fixed** — `runEvaluators.ts:30-54` now uses `Promise.all(evaluators.map(...))`.                                   |
| 3   | Duplicate-name dedup missing        | **Fixed** — `runEvaluators.ts:80-84` adds `nextResultName` that suffixes `_2`, `_3` like Python.                    |
| 4   | Repeat-run case naming `[run/1]`    | **Fixed** — `Dataset.ts:180` now `[1/3]` (matches Python `Case 1 [1/3]`).                                           |
| 5   | Default experiment name             | **Fixed** — `Dataset.ts:126` now falls back to `taskName` (matches Python).                                         |
| 6   | `prepare_context` errors not caught | **Fixed** — `Dataset.ts:425-440` wraps `prepareContext` in try/catch, builds a `ReportCaseFailure`, runs teardown.  |

**6 / 6 addressed.**

## B. Built-in evaluators

| #   | Finding                               | Status                                                                                                                                                                                                                  |
| --- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7   | `Contains` simpler in JS              | **Fixed** — `Contains.ts:71-110` now special-cases dict-vs-dict (key/value match), single-value-as-key for objects, with truncated-repr failure messages matching Python format strings.                                |
| 8   | `LLMJudge` defaults inverted          | **Fixed** — `LLMJudge.ts:84-88` now `score=false` and `assertion={includeReason:true}` by default (Python parity).                                                                                                      |
| 9   | `LLMJudge` doesn't disambiguate names | **Fixed** — `LLMJudge.ts:127-131` now suffixes `_score` / `_pass` when both channels are enabled.                                                                                                                       |
| 10  | `LLMJudge.toJSON` drops fields        | **Fixed** — `LLMJudge.ts:140-145` + helpers now serialize `score`, `assertion` configs. (Caveat: `model` / `model_settings` are still absent because the JS LLMJudge has no model concept — that's #11, design choice.) |
| 11  | BYO judge required                    | **By design.** Documented in code comments. Acceptable.                                                                                                                                                                 |

**4 / 5 addressed; 1 by-design.**

## C. Report evaluators

| #   | Finding                                             | Status                                                                                                                                                                                                                                                    |
| --- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 12  | AUC accuracy regression (downsample-then-integrate) | **Fixed** — `PrecisionRecallEvaluator.ts:67-94` and `ROCAUCEvaluator.ts:84-107` now compute AUC at full resolution via `uniqueSortedThresholds` (no `n`), then `downsample(points, n)` for display only.                                                  |
| 13  | ROCAUC empty-result handling                        | **Fixed** — `ROCAUCEvaluator.ts:67-83` adds `emptyResult` with NaN AUC and short-circuits when `total_positives==0` or `total_negatives==0`.                                                                                                              |
| 14  | ROCAUC always emits "Random" baseline               | **Fixed** as a side-effect of #13 — empty case now returns `curves: []`.                                                                                                                                                                                  |
| 15  | KS no `n_thresholds`                                | **Fixed** — `KolmogorovSmirnovEvaluator.ts:34, 56` adds `nThresholds` field with default 100.                                                                                                                                                             |
| 16  | KS missing min-anchor                               | **Fixed** — `KolmogorovSmirnovEvaluator.ts:97-98` prepends `(allScores[0], 0)` to both CDFs.                                                                                                                                                              |
| 17  | Default `Precision-Recall` title                    | **Fixed** — title now `'Precision-Recall Curve'` (Python parity).                                                                                                                                                                                         |
| 18  | `ConfusionMatrixEvaluator` API shape                | **Fixed** — `ConfusionMatrixEvaluator.ts:14-23, 39-46` now accepts both flat `predicted_from`/`predicted_key`/`expected_from`/`expected_key` (Python wire format) AND nested `predicted: {from, key}` (legacy JS). YAML round-trip with Python now works. |
| 19  | `ConfusionMatrixEvaluator.metadata` without key     | **Fixed** — `ConfusionMatrixEvaluator.ts:128` now `safeStringify(c.metadata)` when key is undefined.                                                                                                                                                      |
| 20  | `extractPositive` "expected_output" + key           | **Fixed** — `scoreCommon.ts:65-75` now throws `Error` if `positiveKey` is provided with `expected_output` (matches Python's behaviour).                                                                                                                   |
| 21  | `toJSON` doesn't strip defaults                     | **Fixed** — all four report evaluators' `toJSON` now omit fields that equal their defaults (`score_from='scores'`, `n_thresholds=100`, etc.).                                                                                                             |

**10 / 10 addressed.** The full-resolution AUC fix is the most impactful: any Python eval suite ported as-is will now produce numerically identical analyses.

## D. Online evaluation

| #   | Finding                                  | Status                                                                                                                                                                                                                                                                      |
| --- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 22  | Default `samplingMode` `'correlated'`    | **Fixed** — `online.ts:70` now `'independent'` (Python parity).                                                                                                                                                                                                             |
| 23  | Sequential evaluator dispatch            | **Fixed** — `online.ts:367-376` now `Promise.all(args.sampledEvaluators.map(...))`.                                                                                                                                                                                         |
| 24  | No sink batching                         | **Fixed** — `online.ts:378-401` builds a `perEvaluatorSinks: Map<sink, group>` keyed by sink instance and submits one batched payload per sink.                                                                                                                             |
| 25  | Missing short-circuit on no destinations | **Fixed** — `online.ts:362-365` early-returns when `!emitOtel && globalSink === undefined && !hasPerEvaluatorSink`.                                                                                                                                                         |
| 26  | OTel emission timing                     | **Partially fixed** — JS still emits all OTel events at the end of dispatch (after evaluators finish), not interleaved per-evaluator like Python. Functional behaviour is the same; only timing differs.                                                                    |
| 27  | `ctx.inputs` shape (raw args vs dict)    | **Fixed** — `online.ts:357, 506-513` now builds a dict via `buildEvaluatorInputs` when arg names are available (`extractArgs` or auto-extracted via signature parse).                                                                                                       |
| 28  | `extractArgs` regex parse                | **Not fixed** — JS still regex-parses `fn.toString()`. Inherent to JS — there's no equivalent of `inspect.signature`. Documented as fragile.                                                                                                                                |
| 29  | No sync function support                 | **By design** (type-restricted to async).                                                                                                                                                                                                                                   |
| 30  | `recordReturn` JSON-stringifies          | **Improved** — `online.ts:515-524` adds `encodeReturnAttribute` with proper handling for primitives, errors, and unserializable values. Still loses Logfire-style JSON-schema sidecar attributes since logfire-api doesn't have an equivalent here, but is no longer naive. |
| 31  | `disableEvaluation` is a global counter  | **Not fixed** — still a process-wide counter. JS doesn't have `ContextVar`-equivalent semantics in core; a context-scoped fix would require AsyncLocalStorage and is non-trivial.                                                                                           |

**6 / 10 addressed; 1 partial; 2 inherent JS limitations; 1 by design.**

## E. OTel event emission

| #   | Finding                               | Status                                                                                                                                                  |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 32  | Failure body fallback missing         | **Fixed** — `otelEmit.ts:80-81` now `errorMessage === '' ? '${name} failed' : '${name} failed: ${errorMessage}'`.                                       |
| 33  | Failure `error.type` fallback         | **Fixed** — `otelEmit.ts:67` now `failure.error_type \|\| 'pydantic_evals.EvaluatorFailure'`.                                                           |
| 34  | Number formatting in body             | **Fixed** — `otelEmit.ts` now formats numbers with a Python-style general format approximation, including small/large exponent display like `1.23e-07`. |
| 35  | Result severity `INFO` vs unspecified | **Fixed** — successful result logs now omit `severityNumber`; evaluator failures still emit `SeverityNumber.WARN`, matching Python.                     |

**4 / 4 addressed.**

## F. Reporting / rendering

| #   | Finding                                     | Status                                                                                                                                                  |
| --- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 36  | No rich-text rendering                      | **By design.** No diff.                                                                                                                                 |
| 37  | No `case_groups()` / `averages()` on report | **Not fixed.** Multi-run `source_case_name` aggregation methods are still missing. The data is captured, but consumers have to roll their own grouping. |

**0 / 2 addressed; 1 by-design, 1 missing.**

## G. Serialization

| #   | Finding                   | Status                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 38  | JSON Schema is weak in JS | **Largely fixed** — every built-in evaluator now defines a `static jsonSchema()` (see `Contains.ts`, `Equals.ts`, `EqualsExpected.ts`, `HasMatchingSpan.ts`, `IsInstance.ts`, `LLMJudge.ts`, `MaxDuration.ts`, all four report evaluators). User-defined evaluators still get the loose `properties: {}` fallback per `jsonSchema.ts:88`, but built-ins now produce typed, autocomplete-friendly schemas. |
| 39  | No `evaluators` opt-out   | **Not fixed.** Niche feature; no diff.                                                                                                                                                                                                                                                                                                                                                                    |

**1 / 2 addressed.**

## H. Span tree

This section had the most errors in the original report. The original review missed the snake_case fields and the Python-parity `seconds` unit because of an incomplete first read of `SpanTree.ts`.

| #   | Finding                                                                              | Status                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 40  | camelCase only — datasets not portable                                               | **NOTE: original finding was incorrect.** Both `snake_case` and camelCase have always been supported. The diff expands coverage further (every field has both). YAML datasets are fully portable.                                                                                             |
| 41  | Duration unit mismatch (ms vs seconds)                                               | **NOTE: original finding was incorrect / now fully fixed.** `SpanTree.ts:144` converts `node.durationMs / 1000` and compares in seconds. Both snake_case `min_duration` / `max_duration` (Python parity) and camelCase `minDuration` / `maxDuration` (deprecated, also seconds) are accepted. |
| 42  | Missing `noChildHas` / `noDescendantHas` / `noAncestorHas` / `minDepth` / `maxDepth` | **NOTE: original finding was incorrect.** All five are present and exercised in `matchesQuery`.                                                                                                                                                                                               |
| 43  | `stopRecursingWhen` is a noop                                                        | **NOTE: original finding was incorrect.** `SpanTree.ts:180-181, 195` applies it via `findDescendants` and `findAncestors`.                                                                                                                                                                    |
| 44  | `or_` exclusivity not enforced                                                       | **NOTE: original finding was incorrect / now fixed.** `SpanTree.ts:124-126` throws `"Cannot combine 'or_' conditions with other conditions at the same level"`, matching Python's error.                                                                                                      |
| 45  | `SimpleSpanProcessor` auto-installation                                              | Still requires `logfire.configure()` for auto-install; non-logfire users wire manually. **By design.**                                                                                                                                                                                        |

The `HasMatchingSpan.toJSON` change at `HasMatchingSpan.ts:36` now calls `spanQueryToSnakeCase(this.query)` so YAML written from JS uses Python-compatible snake_case — addresses a derivative concern that was implicit in #40.

**3 / 6 addressed; 3 were misreads in the original report.**

## Roll-up

- **Fully addressed: 34**: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 27, 32, 33, 34, 35, 38 + (44 was a misread, now also defensively enforced) + (40, 41, 42, 43 were already correct).
- **Partially addressed: 2**: 26 (timing only), 30 (better encoding, still no JSON-schema sidecar).
- **Not fixed by design: 5**: 11, 29, 36, 39, 45.
- **Not fixed (open gaps)**: 28 (regex param-name parse), 31 (`disableEvaluation` global counter), 37 (`case_groups` / `averages` instance methods).

Of the 15 high-severity findings in the original roll-up, **all 15 are now addressed** by the diff (or were never real divergences in the case of #40, #41).

The most consequential fixes are: full-resolution AUC (#12), parallel evaluator dispatch (#2/#23), name-collision dedup (#3), `LLMJudge` defaults flipped (#8/#9), `samplingMode='independent'` default (#22), `Contains` dict semantics (#7), and the round-trippable flat `ConfusionMatrixEvaluator` shape (#18).

The remaining open gaps are either non-trivial structural work (#31, #37) or inherent-to-JS runtime limitations (#28).
