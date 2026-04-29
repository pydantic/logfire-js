# Logfire-JS Evals Port — Scoping & PRD

## 0. Context recap

We're redoing **PR #104** (closed). The goal is to bring Pydantic-evals-equivalent functionality into `logfire-js`, **inside the existing `logfire` package** (not a new `@pydantic/evals-js`), focused on:

1. **Offline evals** — `Dataset` + `Case` + `Evaluator`, plus a `dataset.evaluate(task)` runner that emits the OTel spans the platform ingests into the `experiments` table and renders in the case-comparison UI.
2. **Online evals** — a wrapper that runs evaluators after a function returns, emits `gen_ai.evaluation.result` log events, and lights up the Live Evals UI.
3. **Wire-format parity with Python** — span names, attribute keys, JSON shapes, log event names — byte-identical, so the same dataset YAML/JSON files work and the same backend code paths fire.

The platform side requires no new ingest work for this — it's already shipping pydantic-evals-emitted data. Our job is to emit equivalent telemetry from TS.

## 1. What PR #104 got wrong (and what we have to do instead)

Boiled down from Petyo's review:

| #104 mistake                                                                                                                   | Redo direction                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| New `@pydantic/evals` package, optional logfire peer                                                                           | Lives **inside `packages/logfire-api`** (published as `logfire`). Hard dependency on its own infra.                                              |
| Hand-rolled `logfire.msg`/`logfire.msg_template` formatting                                                                    | Reuse `logfireFormatWithExtras`, `serializeAttributes`, `LogfireAttributeScrubber` from `packages/logfire-api/src/`.                             |
| Span-tree capture required user to manually pass `additionalSpanProcessors: [getSpanTreeProcessor()]` to `logfire.configure()` | `logfire.configure()` (Node) auto-installs the span-tree processor. Manual hook only needed for non-Node setups.                                 |
| Online evals only fired user-supplied sinks; no default OTel events                                                            | Default emission is OTel `gen_ai.evaluation.result` log events, as per the platform design doc. Sinks are additive.                              |
| Report evaluators ran _after_ `evaluate {name}` span closed → analyses never on the experiment span                            | Run report evaluators inside the same span; close the span only after `logfire.experiment.analyses` etc. are set.                                |
| `traceId`/`spanId` always `null` on report cases                                                                               | Pull from the active OTel span context as each case opens; populate.                                                                             |
| Hard-coded dep versions, no changeset, no examples, no docs                                                                    | Use the pnpm catalog; ship a changeset; add `examples/evals/` and a Node-example evals subsection; coordinate docs.                              |
| Runtime reliance on `constructor.name` + Vite `keepNames` for evaluator serialization                                          | Static `evaluatorName` (defaults to constructor name but overridable) + an explicit registry. Survives minification.                             |
| Missing `fromFile`/`toFile`, JSON-schema generation, retry, runtime validation                                                 | Ship all four. Use `zod` for runtime validation, `js-yaml` for YAML, `p-retry` for retries.                                                      |
| Sync-decorator typed as preserving sync return type but runtime returned `Promise`                                             | Type and runtime must agree. We'll only support async-returning functions for online evals (matches Python's behavior on JS-native concurrency). |

## 2. Architecture — package boundary and entry points

### 2.1 Where the code lives

```
packages/
  logfire-api/                          (published as `logfire`)
    src/
      evals/                            ← NEW directory; runtime-agnostic core
        index.ts                        (barrel)
        Case.ts
        Dataset.ts
        Evaluator.ts                    (base class + EvaluatorContext)
        builtins/                       (Equals, EqualsExpected, Contains, IsInstance, MaxDuration, HasMatchingSpan, LLMJudge)
        reportEvaluators/               (ConfusionMatrix, PrecisionRecall, ROCAUC, KS)
        reporting/                      (EvaluationReport, ReportCase[Failure], ReportCaseAggregate)
        online.ts                       (withOnlineEvaluation, configure, OnlineEvalConfig)
        otelEmit.ts                     (gen_ai.evaluation.result emission — port of _otel_emit.py)
        spanTree/                       (SpanNode, SpanTree, SpanQuery, ContextInMemorySpanExporter)
        registry.ts                     (evaluator class registry for serialization round-trip)
        serialization/                  (yaml + json + jsonSchema)
        constants.ts                    (gen_ai.evaluation.*, logfire.experiment.*)

  logfire-node/                         (published as `@pydantic/logfire-node`)
    src/
      evalsConfig.ts                    ← NEW — auto-wires span-tree processor in `configure()`
      evalsCli/                         ← NEW (optional) — `logfire-evals` CLI for running dataset files
```

**Why `logfire-api` and not `logfire-node`:** the runtime-agnostic core (Dataset/Case/Evaluator/online wrapper) doesn't need Node primitives. `AsyncLocalStorage` is only needed for online evals' "current task run" gating, and `node:async_hooks` is the right import — but it can be lazy/optional and the browser package can pass through with a no-op. Filesystem helpers (`Dataset.fromFile`, `Dataset.toFile`) live in `logfire-api` but accept either a path (Node) or a string content (universal); the path branch dynamically imports `node:fs/promises`. This keeps the API one symbol regardless of runtime, with a clean failure mode in browsers.

### 2.2 Package exports

`logfire` already exports a flat surface from `.`. Adding ~40 evals symbols there will balloon the surface. Proposal:

```jsonc
// packages/logfire-api/package.json (sketch)
"exports": {
  ".":       { /* existing */ },
  "./evals": {
    "import":  { "types": "./dist/evals.d.ts",  "default": "./dist/evals.js"  },
    "require": { "types": "./dist/evals.d.cts", "default": "./dist/evals.cjs" }
  }
}
```

User code:

```ts
import * as logfire from '@pydantic/logfire-node' // configure + tracing
import { Dataset, Case, Equals, EqualsExpected, withOnlineEvaluation } from 'logfire/evals'
```

This keeps `import 'logfire'` lean (no zod / no js-yaml in the import graph for users not using evals) and gives evals a discoverable namespace. Both `logfire-node` and `logfire-browser` will re-export `logfire/evals` from their own `./evals` subpaths so users can stay on a single import root if they want.

## 3. Public API design

### 3.1 `Case`

```ts
class Case<Inputs, Output, Metadata = unknown> {
  readonly name?: string
  readonly inputs: Inputs
  readonly metadata?: Metadata
  readonly expectedOutput?: Output
  readonly evaluators: ReadonlyArray<Evaluator<Inputs, Output, Metadata>>

  constructor(opts: {
    name?: string
    inputs: Inputs
    expectedOutput?: Output
    metadata?: Metadata
    evaluators?: ReadonlyArray<Evaluator<Inputs, Output, Metadata>>
  })
}
```

Notes:

- `expectedOutput` (not `expected_output`) — TS idiom. We map TS camelCase → wire snake_case at emission time.
- All fields readonly; `Case` is a value object, no mutators.
- Generics default to `unknown` (not `any`) — gives users useful errors; matches `noUncheckedIndexedAccess`.

### 3.2 `Dataset`

```ts
class Dataset<Inputs, Output, Metadata = unknown> {
  name: string
  cases: Case<Inputs, Output, Metadata>[]
  evaluators: Evaluator<Inputs, Output, Metadata>[]
  reportEvaluators: ReportEvaluator<Inputs, Output, Metadata>[]

  constructor(opts: {
    name: string
    cases?: ReadonlyArray<Case<Inputs, Output, Metadata>>
    evaluators?: ReadonlyArray<Evaluator<Inputs, Output, Metadata>>
    reportEvaluators?: ReadonlyArray<ReportEvaluator<Inputs, Output, Metadata>>
  })

  addCase(opts: { /* same shape as Case constructor */ }): void
  addEvaluator(evaluator: Evaluator<Inputs, Output, Metadata>, options?: { specificCase?: string }): void

  evaluate(
    task: (inputs: Inputs) => Output | Promise<Output>,
    options?: EvaluateOptions<Inputs, Output, Metadata>
  ): Promise<EvaluationReport<Inputs, Output, Metadata>>

  // Async — fs reads dynamically imported on Node
  static fromFile<I = unknown, O = unknown, M = unknown>(path: string, options?: FromFileOptions): Promise<Dataset<I, O, M>>
  static fromText<I = unknown, O = unknown, M = unknown>(
    text: string,
    options: { format: 'yaml' | 'json' } & FromFileOptions
  ): Dataset<I, O, M>
  static fromObject<I = unknown, O = unknown, M = unknown>(data: unknown, options?: FromFileOptions): Dataset<I, O, M>

  toFile(path: string, options?: ToFileOptions): Promise<void>
  toText(format: 'yaml' | 'json', options?: ToFileOptions): string

  jsonSchema(options?: {
    customEvaluators?: ReadonlyArray<EvaluatorClass<Inputs, Output, Metadata>>
    customReportEvaluators?: ReadonlyArray<ReportEvaluatorClass<Inputs, Output, Metadata>>
  }): JsonSchema
}

interface EvaluateOptions<Inputs, Output, Metadata> {
  name?: string // experiment name override (defaults to dataset.name)
  taskName?: string // defaults to function name
  maxConcurrency?: number // semaphore-bounded; undefined = unbounded
  metadata?: Record<string, unknown> // user-provided experiment metadata
  repeat?: number // run each case N times (default 1)
  retryTask?: RetryConfig // p-retry-shaped
  retryEvaluators?: RetryConfig
  progress?: boolean | ProgressCallback
  lifecycle?: CaseLifecycleClass<Inputs, Output, Metadata>
  signal?: AbortSignal // standard cancellation
}
```

Notes:

- `evaluate` returns `Promise<EvaluationReport>`. There is no `evaluateSync` — JS doesn't need one (every consumer is fine with async at the top-level), and the Python `evaluate_sync` exists only to bridge sync test runners.
- `progress` accepts `true` (default reporter to stderr — we'll write a small TTY-aware one), a callback `(done, total, currentCase) => void`, or `false`/`undefined`. We _will_ wire up the callback (PR #104 had it stubbed).
- `signal: AbortSignal` is novel relative to Python's API — TS-idiomatic and free if we propagate to the semaphore + each case's task call.

### 3.3 `Evaluator` base

```ts
abstract class Evaluator<Inputs = unknown, Output = unknown, Metadata = unknown> {
  // Class-level, used for serialization. Defaults to the class's static `evaluatorName`
  // or, as fallback, the constructor name. Survives minification because users set
  // it explicitly on subclasses.
  static evaluatorName?: string

  // Optional, propagated to gen_ai.evaluation.evaluator.version
  evaluatorVersion?: string

  // Optional, overrides the default evaluation result name in reports
  evaluationName?: string

  abstract evaluate(ctx: EvaluatorContext<Inputs, Output, Metadata>): EvaluatorOutput | Promise<EvaluatorOutput>

  // Internal — computes the EvaluatorSpec used for the wire-format `source` field
  protected toSpec(): EvaluatorSpec
}

type EvaluatorOutput =
  | boolean // assertion
  | number // score
  | string // label
  | EvaluationReason // scalar with explanation
  | Record<string, boolean | number | string | EvaluationReason> // multi-result

interface EvaluationReason {
  value: boolean | number | string
  reason?: string
}

interface EvaluatorContext<Inputs, Output, Metadata> {
  readonly name?: string
  readonly inputs: Inputs
  readonly metadata?: Metadata
  readonly expectedOutput?: Output
  readonly output: Output
  readonly duration: number // seconds (matches Python)
  readonly spanTree: SpanTree // throws on access if recording wasn't available
  readonly attributes: Record<string, unknown>
  readonly metrics: Record<string, number>
}
```

Notes:

- TS doesn't have Python's `@dataclass` introspection. We replace it with a small registry token + an opt-in `static evaluatorName`. The registry maps name → class; it's how YAML/JSON dataset files round-trip. Users register custom evaluators with `registerEvaluator(MyEvaluator)`; the seven builtins auto-register on import.
- We don't enforce dataclass-style "auto-extract constructor args for serialization" magic. Instead, evaluators that need YAML/JSON serialization expose `toJSON()` (or a `serialize()` method) that returns the args. Most builtins are trivially serializable; custom ones can either implement it or be excluded from on-disk datasets (and we error loudly).
- `EvaluatorContext.metrics` is auto-populated by walking the captured span tree for `gen_ai.usage.*` and `operation.cost` — same logic as Python's `_task_run.extract_span_tree_metrics`.
- `set_eval_attribute` / `increment_eval_metric` (Python module-level helpers) become `setEvalAttribute(name, value)` and `incrementEvalMetric(name, amount)`, both pulling the current task-run from an `AsyncLocalStorage`-backed context.

### 3.4 Built-in evaluators

```ts
class Equals {
  constructor(opts: { value: unknown; evaluationName?: string })
}
class EqualsExpected {
  constructor(opts?: { evaluationName?: string })
}
class Contains {
  constructor(opts: { value: unknown; caseSensitive?: boolean; asStrings?: boolean; evaluationName?: string })
}
class IsInstance {
  constructor(opts: { typeName: string; evaluationName?: string })
} // TS: matches by class name walk through prototype chain
class MaxDuration {
  constructor(opts: { seconds: number })
} // accept number-of-seconds (Python: float|timedelta)
class HasMatchingSpan {
  constructor(opts: { query: SpanQuery; evaluationName?: string })
}
class LLMJudge {
  constructor(opts: {
    rubric: string
    judge?: JudgeFn // BYO; if omitted, throws unless setDefaultJudge() was called
    includeInput?: boolean
    includeExpectedOutput?: boolean
    score?: OutputConfig | false // default: { evaluationName: 'LLMJudge', includeReason: false }
    assertion?: OutputConfig | false // default: { evaluationName: 'LLMJudge', includeReason: true }
  })
}
```

For `LLMJudge`: PR #104's BYO-callback approach is fine for v1 — we don't have a TS pydantic-ai equivalent yet. We can ship a small `setDefaultJudge(fn)` for ergonomic defaults. Documented as "BYO model client" until pydantic-ai-js or similar exists.

`HasMatchingSpan` requires the span-tree processor to be installed. When a custom OTel provider is in use and the processor wasn't installed, `ctx.spanTree` access throws a `SpanTreeRecordingError` with actionable text — same as Python.

### 3.5 Report-level evaluators

```ts
abstract class ReportEvaluator<Inputs, Output, Metadata> {
  static evaluatorName?: string
  abstract evaluate(
    ctx: ReportEvaluatorContext<Inputs, Output, Metadata>
  ): ReportAnalysis | ReportAnalysis[] | Promise<ReportAnalysis | ReportAnalysis[]>
}
```

Built-ins: `ConfusionMatrixEvaluator`, `PrecisionRecallEvaluator`, `ROCAUCEvaluator`, `KolmogorovSmirnovEvaluator` — all four. Math is straightforward; the AUC/CDF computations are <100 LoC each in Python and translate directly.

`ReportAnalysis` is a discriminated union: `{ type: 'confusion_matrix' | 'precision_recall' | 'roc_curve' | 'ks' | 'scalar' | 'table' | 'line_plot' } & {...}`. Renders to `logfire.experiment.analyses` as JSON-serialized objects.

### 3.6 Online evals — `withOnlineEvaluation`

Decorators are awkward in TS without Stage 3 mainline support. HOF is cleaner:

```ts
function withOnlineEvaluation<F extends (...args: any[]) => Promise<unknown>>(
  fn: F,
  opts: {
    evaluators: ReadonlyArray<Evaluator<unknown, Awaited<ReturnType<F>>>>
    target?: string // default: fn.name
    msgTemplate?: string // default: 'Calling {target}'
    spanName?: string // default: same as msgTemplate, formatted
    sampleRate?: number | ((ctx: SamplingContext) => number | boolean)
    samplingMode?: 'independent' | 'correlated' // default: 'correlated'
    extractArgs?: boolean | ReadonlyArray<string>
    recordReturn?: boolean
    sink?: EvaluationSink // additive; OTel events still emit unless emitOtelEvents=false
    emitOtelEvents?: boolean // default: true
    includeBaggage?: boolean // default: true
    onError?: (e: unknown, evaluatorName: string) => void
    onMaxConcurrency?: (evaluatorName: string) => void
    onSamplingError?: (e: unknown) => void
  }
): F

function configureOnlineEvals(opts: Partial<OnlineEvalConfig>): void
function disableEvaluation<T>(fn: () => T): T // ALS-scoped; suppresses online dispatch
async function waitForEvaluations(opts?: { timeoutMs?: number }): Promise<void> // for tests
```

Notes:

- **Async-only.** Python's sync→thread fallback doesn't fit JS; we type-restrict `F`.
- Background dispatch: schedule via `queueMicrotask` after the wrapped function's span closes; gated by an `OnlineEvaluator` per-evaluator semaphore (we'll write a small one — there's no `Semaphore` in stdlib).
- Suppressed inside `Dataset.evaluate` automatically (same `currentTaskRun` ALS gate as offline; no double-evaluation).
- Sinks run in addition to OTel events. To kill OTel emission, set `emitOtelEvents: false`.
- `SamplingMode = 'correlated'` is the default (matches Python), so lower-rate evaluators are subsets of higher-rate ones for the same call.

### 3.7 Lifecycle hooks

```ts
abstract class CaseLifecycle<Inputs, Output, Metadata = unknown> {
  protected case!: Case<Inputs, Output, Metadata>
  setup?(): Promise<void> | void
  prepareContext?(
    ctx: EvaluatorContext<Inputs, Output, Metadata>
  ): Promise<EvaluatorContext<Inputs, Output, Metadata>> | EvaluatorContext<Inputs, Output, Metadata>
  teardown?(result: ReportCase<Inputs, Output, Metadata> | ReportCaseFailure<Inputs, Output, Metadata>): Promise<void> | void
}
```

Pass the **class** (not an instance) to `Dataset.evaluate({ lifecycle: MyLifecycle })`; framework news up one per case.

## 4. Wire-format contract — the parity oracle

This is what fusionfire/UI ingest reads. **Every name is a literal**; do not template-format span names away (e.g. don't emit `'evaluate sentiment-classifier'`, emit `'evaluate {name}'` as the span name, with `name='sentiment-classifier'` as an attribute).

### 4.1 Span hierarchy

```
evaluate {name}                          [span]   ← experiment span
├── case: {case_name}                    [span]
│   ├── execute {task}                   [span]   ← user task root; span tree captured here
│   └── evaluator: {evaluator_name}      [span]   ← per-evaluator
│   └── ...
└── report_evaluator: {evaluator_name}   [span]   ← runs INSIDE the experiment span, sequential

withOnlineEvaluation:
{user-defined call span}                 [span]
├── evaluator: {evaluator_name}          [span]   ← parented via NonRecording span context
└── gen_ai.evaluation.result             [log]    ← parented via NonRecording span context
```

OTel scope name for all of the above: **`pydantic-evals`** (matches Python; lets the platform's Condition-1 ingest match work without relying on `gen_ai.operation.name`). We'll also set `gen_ai.operation.name = 'experiment'` on the experiment span (Condition 2).

### 4.2 Experiment span (`evaluate {name}`)

Initial attributes:

| Key                         | Source                                             | Notes                      |
| --------------------------- | -------------------------------------------------- | -------------------------- |
| `logfire.span_type`         | `'span'`                                           |                            |
| `logfire.msg_template`      | literal `'evaluate {name}'`                        |                            |
| `logfire.msg`               | `'evaluate {task_name}'` formatted                 |                            |
| `name`                      | experiment name (= dataset name unless overridden) |                            |
| `task_name`                 | `task.name \|\| options.taskName`                  |                            |
| `dataset_name`              | `dataset.name`                                     |                            |
| `n_cases`                   | `dataset.cases.length * (repeat ?? 1)`             |                            |
| `gen_ai.operation.name`     | `'experiment'`                                     | Condition-2 ingest matcher |
| `metadata`                  | `options.metadata`, only if set                    | as JSON object             |
| `logfire.experiment.repeat` | `repeat`, only if `> 1`                            | int                        |

Set after evaluation completes (BEFORE the span ends):

| Key                                            | Source                                                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `assertion_pass_rate`                          | float, only if assertions exist                                                                       |
| `logfire.experiment.metadata`                  | `{ n_cases, repeat?, metadata?, averages? }` — `averages` block must be present for sort-by-pass-rate |
| `logfire.experiment.analyses`                  | `ReportAnalysis[]`, only if report evaluators ran                                                     |
| `logfire.experiment.report_evaluator_failures` | `EvaluatorFailure[]`, only on failure                                                                 |

The `averages` block under `logfire.experiment.metadata` is load-bearing for the platform — see fusionfire `experiments.py:222–231`. Shape:

```ts
{
  name: string,                                          // dataset / experiment name
  scores:    Record<string, { mean: number, count: number, ... }>,
  metrics:   Record<string, { mean: number, count: number, ... }>,
  labels:    Record<string, Record<string, number>>,    // label → frequency dist
  assertions: number | null,                             // pass rate, NUMERIC (not string)
  task_duration: number,
  total_duration: number
}
```

### 4.3 Case span (`case: {case_name}`)

Identification: literal `case_name` attribute on a span whose `parent_span_id == <experiment span_id>`. This is how the UI finds cases.

| Key                                   | Set when         | Notes                                                              |
| ------------------------------------- | ---------------- | ------------------------------------------------------------------ |
| `logfire.span_type`                   | always           | `'span'`                                                           |
| `logfire.msg_template`                | always           | `'case: {case_name}'`                                              |
| `logfire.msg`                         | always           | formatted                                                          |
| `task_name`                           | always           |                                                                    |
| `case_name`                           | always           | **must be top-level**                                              |
| `inputs`                              | always           | object, JSON-shaped attribute (see §4.7)                           |
| `metadata`                            | if set           | object                                                             |
| `expected_output`                     | if set           | object                                                             |
| `logfire.experiment.source_case_name` | `repeat > 1`     | original case name; derived case name becomes `"<source> [run/N]"` |
| `output`                              | after task       | object                                                             |
| `task_duration`                       | after task       | seconds, NUMERIC                                                   |
| `metrics`                             | after task       | `Record<string, number>`                                           |
| `attributes`                          | after task       | `Record<string, unknown>` (case-level free-form)                   |
| `assertions`                          | after evaluators | `Record<string, EvaluationResultJson>` — see §4.7                  |
| `scores`                              | after evaluators | same                                                               |
| `labels`                              | after evaluators | same                                                               |

On task failure, `case_span.recordException(err)` and the entry becomes a `ReportCaseFailure`.

### 4.4 Evaluator span (`evaluator: {evaluator_name}`)

**Critical gotcha** — Python uses a _dual_ template/name pattern:

- Friendly `logfire.msg_template = 'Calling evaluator: {evaluator_name}'`
- Stable span name = `'evaluator: {evaluator_name}'` (literal, not interpolated)

Reason: the friendly string is for human eyes in tail logs; the stable name is what Logfire saved-views / queries match on. Our TS port must emit both. `logfire.span()` doesn't currently expose a "set span name independent of msg_template" knob — we'll add a private `_spanName` option to `LogOptions` (mirror `pydantic_evals/_utils.py:logfire_span`'s `_span_name` kwarg). Public ergonomics aren't needed; internal evals code can use it.

| Key                    | Value                                                                      |
| ---------------------- | -------------------------------------------------------------------------- |
| `logfire.span_type`    | `'span'`                                                                   |
| `logfire.msg_template` | `'Calling evaluator: {evaluator_name}'`                                    |
| `logfire.msg`          | formatted                                                                  |
| span name (literal)    | `'evaluator: {evaluator_name}'`                                            |
| `evaluator_name`       | the evaluator's class-level `evaluatorName` (or constructor name fallback) |

### 4.5 Online eval log event (`gen_ai.evaluation.result`)

Emitted as an **OTel LogRecord** via `@opentelemetry/api-logs` — NOT a span. Platform Live Evals match `kind == 'log' AND span_name == 'gen_ai.evaluation.result'` (literal). Logger scope: `'pydantic-evals'`.

Required and recommended attributes (port from `pydantic_evals/_otel_emit.py:38–53` verbatim):

```ts
// Constants — copy verbatim from Python; do not rename.
export const GEN_AI_EVAL_NAME = 'gen_ai.evaluation.name'
export const GEN_AI_SCORE_VALUE = 'gen_ai.evaluation.score.value' // double
export const GEN_AI_SCORE_LABEL = 'gen_ai.evaluation.score.label' // string
export const GEN_AI_EXPLANATION = 'gen_ai.evaluation.explanation'
export const GEN_AI_EVAL_TARGET = 'gen_ai.evaluation.target' // Pydantic ext
export const GEN_AI_EVALUATOR_SOURCE = 'gen_ai.evaluation.evaluator.source' // Pydantic ext, JSON-encoded EvaluatorSpec
export const GEN_AI_EVALUATOR_VERSION = 'gen_ai.evaluation.evaluator.version' // Pydantic ext
export const ERROR_TYPE = 'error.type'
```

Encoding rules (must match Python — see `_otel_emit.py:217–231`):

- `boolean true` → `score.value = 1.0`, `score.label = 'pass'` **(dual emit)**
- `boolean false` → `score.value = 0.0`, `score.label = 'fail'` **(dual emit)**
- `number` → `score.value` only
- `string` → `score.label` only
- `EvaluationReason` → unwrap; the `.reason` text goes to `gen_ai.evaluation.explanation`
- Failures → `error.type = err.constructor.name || 'EvaluatorFailure'`, severity `WARN`, body `'evaluation: {name} failed: {message}'`, no score attrs.
- Body string format: `'evaluation: {name}={value}'` where bool = `'True'|'False'` (capitalized — matches Python's `repr`), str = quoted, number = `g`-format.

Baggage: when `includeBaggage`, snapshot OTel baggage onto attributes; standard `gen_ai.*` and `error.type` win on conflict.

Parenting: events should be parented to the wrapped function's call span. We do this by extracting `{traceId, spanId}` from the call span and constructing a `NonRecordingSpan` to set as the active context when emitting (mirror Python's `build_parent_context` at `_otel_emit.py:113–128`).

`gen_ai.evaluation.score.value` MUST be a numeric attribute, not a stringified number — the platform does `CAST(... AS DOUBLE)` and will throw on non-numeric strings.

### 4.6 EvaluationResult JSON shape (case scores/labels/assertions)

The wire shape that the frontend Zod parser strict-rejects unless it matches:

```ts
interface EvaluationResultJson {
  name: string // evaluator-result name
  value: number | string | boolean
  reason: string | null
  source: {
    name: string // evaluator class name (the registry key)
    arguments: null | unknown[] | Record<string, unknown>
  }
  evaluator_version?: string // optional
}
```

`source.arguments` follows the same compact-form rules as `EvaluatorSpec` serialization in YAML (§5).

### 4.7 Attribute serialization — JSON object vs JSON-encoded string

Object-valued attributes (`logfire.experiment.metadata`, `scores`, `labels`, `assertions`, `metrics`, `inputs`, `output`, `metadata`, `expected_output`, `attributes`) **must round-trip as JSON objects**, not as JSON-encoded strings, because fusionfire decodes the OTel attributes envelope once and accesses children directly.

The existing `serializeAttributes()` in `packages/logfire-api/src/serializeAttributes.ts` already does this correctly: complex values get JSON-stringified at the OTel-attribute boundary, with a sidecar `logfire.json_schema` attribute carrying the type so the backend can decode them back. **Use it for all evals attributes** — Petyo's review specifically called out PR #104 reimplementing this.

## 5. Dataset serialization (YAML/JSON) and JSON schema

### 5.1 Wire format

Same as Python (round-trip with `pydantic-evals` files):

```yaml
# yaml-language-server: $schema=./sentiment_schema.json
name: sentiment-classifier
cases:
  - name: positive-1
    inputs: { text: 'I love this!' }
    expected_output: POSITIVE
  - name: great-with-contains
    inputs: { text: 'it is great' }
    expected_output: POSITIVE
    evaluators:
      - Contains: { value: POSITIVE } # short form (single positional)
evaluators:
  - EqualsExpected # short form (no args)
  - LLMJudge: { rubric: 'Output is non-empty.' } # long form (kwargs)
```

Three short forms, identical to Python's `EvaluatorSpec`:

1. Bare string → `EvaluatorName` (no args)
2. Single-key object with non-dict value → `{Name: positionalArg}`
3. Single-key object with dict value → `{Name: {kwarg1: ..., kwarg2: ...}}`

The ambiguity edge case from `pydantic-evals/evaluators/_spec.py:36–46` — a single positional arg whose JSON form is a string-keyed dict — must use the long form to round-trip. We carry the same rule.

### 5.2 JSON Schema generation

`Dataset.jsonSchema()` produces a JSON Schema document with:

- `$schema` self-reference
- `evaluators` typed as a discriminated union of one TypedDict per registered evaluator, plus the bare-name string literal
- Same for `report_evaluators`

Implementation: walk the registry; for each evaluator class, derive a JSON schema for its constructor opts (we'll attach a static `jsonSchema()` to each builtin returning a hand-rolled schema; users can do the same on their own evaluators). Compose into a top-level Dataset schema. We'll **use `zod`** as the runtime-validation layer for `fromFile`/`fromText`/`fromObject` (`zod`'s `toJSONSchema` handles emission for us as a bonus); validation errors get aggregated into one `AggregateError`-style throw.

**Add `zod` to the pnpm catalog** (currently absent from logfire-js). We'll also need `js-yaml` for YAML support; can be limited to `logfire-api` (works in browser too). Both small, zero-dep adjacent.

### 5.3 Default-skipping in evaluator serialization

Python excludes any evaluator field whose value equals its declared default. We replicate by giving each builtin a `toJSON()` that knows its defaults. Custom evaluators can either implement `toJSON()` themselves or be marked `serializable: false` (and we error if a dataset including them tries to serialize).

## 6. Span-tree capture

Auto-install on `configure()` (Node, Browser, CF Workers). The processor is a `SimpleSpanProcessor` wrapping a memory-buffered exporter keyed on a per-task-run context ID stored in an `AsyncLocalStorage`-managed `ContextVar` analogue.

```ts
// In packages/logfire-node/src/logfireConfig.ts
import { getEvalsSpanProcessor } from 'logfire/evals/internal'

function configure(options: LogfireConfigOptions) {
  // ...existing setup...
  const evalsProcessor = getEvalsSpanProcessor()
  spanProcessors.push(evalsProcessor)
  // ...
}
```

For users running their own `TracerProvider` (e.g. someone wiring up OTel manually before `logfire.configure()`), expose the processor as `getEvalsSpanProcessor()` in `logfire/evals` so they can install it themselves. If neither auto-install nor manual install happened, `ctx.spanTree` access throws `SpanTreeRecordingError` with a clear remediation message — matches Python.

The exporter is gated on a **per-execute-task ContextVar** (Python's `_EXPORTER_CONTEXT_ID`) so concurrent cases under `maxConcurrency > 1` don't see each other's spans. We'll back this with `AsyncLocalStorage` — the runtime's standard pattern. (Browser-side: `StackContextManager` doesn't have an ALS analogue, so for browser use we'll either disable concurrent execute and document the limitation, or adopt a simple per-execute promise chain.)

`SpanTree` and `SpanQuery` get straight ports of Python's API surface. The query DSL is `TypedDict`-shaped in Python; we keep it as a TS `interface`. Fields:

- `nameEquals`, `nameContains`, `nameMatchesRegex`
- `hasAttributes`, `hasAttributeKeys`
- `minDuration`, `maxDuration`
- `not_`, `and_`, `or_` (note: `not`, `and`, `or` are reserved in TS)
- `minChildCount`, `maxChildCount`, `someChildHas`, `allChildrenHave`
- `minDescendantCount`, `maxDescendantCount`, `someDescendantHas`, `allDescendantsHave`
- `someAncestorHas`, `allAncestorsHave`
- `stopRecursingWhen`

## 7. Implementation phases

### Phase 1 — Foundation (PR 1, smallish)

1. Add `zod`, `js-yaml`, `p-retry` to pnpm catalog.
2. Add `./evals` export entry to `packages/logfire-api/package.json`.
3. Internal: extend `LogOptions` with `_spanName?: string` (private) so we can decouple span name from msg_template for the `evaluator:` span dual-emission. Verify it passes through `logfireFormatWithExtras`.
4. Add `gen_ai.evaluation.*` and `logfire.experiment.*` constant files. No public re-export.
5. Add the evaluator class registry and an `AsyncLocalStorage`-backed `currentTaskRun` context.

### Phase 2 — Offline core (PR 2, the big one)

1. `Case`, `Dataset`, `Evaluator`, `EvaluatorContext`, `ReportEvaluator`, `ReportEvaluatorContext`.
2. `Dataset.evaluate` driver — semaphore concurrency, per-case spans, per-evaluator spans, attribute emission (after-task and after-evaluators), report-eval execution INSIDE the experiment span, populated trace_id/span_id on `ReportCase` and `EvaluationReport`.
3. Built-in evaluators: `Equals`, `EqualsExpected`, `Contains`, `IsInstance`, `MaxDuration`, `LLMJudge` (BYO callback).
4. `setEvalAttribute`, `incrementEvalMetric`, gen_ai-usage-from-span-tree metric extraction.
5. Vitest tests against an `InMemorySpanExporter`-backed `BasicTracerProvider`. Mirror the Python snapshot tests for span attributes — see §10.

### Phase 3 — Span tree + HasMatchingSpan (PR 3)

1. `ContextInMemorySpanExporter`, `SpanTree`, `SpanNode`, `SpanQuery` ports.
2. Auto-install of the evals processor in `logfire-node.configure()`. Hook for `logfire-browser` and `logfire-cf-workers` packages.
3. `HasMatchingSpan` evaluator.
4. Tests for span-tree access from inside evaluators, including the no-recording fail-loud path.

### Phase 4 — Serialization (PR 4)

1. YAML and JSON read/write (`fromFile`, `fromText`, `fromObject`, `toFile`, `toText`).
2. `Dataset.jsonSchema()` and the `_save_schema` idempotent sidecar-write.
3. Round-trip tests against pydantic-evals fixture files (we'll snapshot a small set of YAML/JSON datasets generated by the Python lib as test fixtures).
4. `EvaluatorSpec` short-form encoder + decoder, including the dict-as-positional ambiguity rule.

### Phase 5 — Reporting (PR 5)

1. `EvaluationReport`, `ReportCase`, `ReportCaseFailure`, `ReportCaseAggregate`, `ReportCaseGroup` types.
2. Report-level evaluators: `ConfusionMatrix`, `PrecisionRecall`, `ROCAUC`, `KolmogorovSmirnov`. Math ports from Python.
3. `report.render()` — plain-text table (no `rich` equivalent in the JS ecosystem worth adopting; we'll write a compact ANSI-aware renderer in <200 LoC, matching column structure of Python's output).
4. Lifecycle hooks (`CaseLifecycle.setup` / `prepareContext` / `teardown`).
5. Retry support via `p-retry`.

### Phase 6 — Online evals (PR 6)

1. `withOnlineEvaluation`, `OnlineEvaluator`, `configureOnlineEvals`.
2. `gen_ai.evaluation.result` log emission via `@opentelemetry/api-logs`. (We'll need to ensure `logfire-node` initializes a `LoggerProvider` — currently it only configures tracing/metrics. Verify and add as a dependency of this PR if missing.)
3. Sampling modes (`independent` / `correlated`), sinks, baggage capture.
4. `disableEvaluation()` for dataset-internal suppression.
5. `waitForEvaluations()` for tests.

### Phase 7 — Polish (PR 7)

1. Examples: `examples/evals/` with a Node demo (mirror the sentiment-classifier example from Petyo's review).
2. Update `examples/node/index.ts` with an `evals.ts` sibling.
3. Root README and `packages/logfire-api/README.md` short evals section.
4. Coordinate with the docs site (logfire.pydantic.dev) on a TS evals docs section.
5. Changesets per phase (each PR gets its own minor-bump changeset).

## 8. Test strategy

The test suite is the single best parity oracle we have. For each Python test file we identify a TS equivalent and structure tests to assert on the _same_ span attributes.

| Python test                                 | TS equivalent                              | What it pins                                                         |
| ------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| `tests/evals/test_dataset.py:1577–1825`     | `evals.test.ts::offline-span-snapshot`     | Full span-attribute snapshot for the four offline span kinds         |
| `tests/evals/test_otel_emit.py` (whole)     | `evals.test.ts::online-event-encoding`     | Every `gen_ai.evaluation.*` attribute combo, severity, baggage merge |
| `tests/evals/test_multi_run.py:357`         | `evals.test.ts::multi-run-attributes`      | `logfire.experiment.repeat`, `logfire.experiment.source_case_name`   |
| `tests/evals/test_report_evaluators.py:935` | `evals.test.ts::report-evaluator-failures` | `logfire.experiment.report_evaluator_failures` shape                 |
| `tests/evals/test_online.py:2360`           | `evals.test.ts::online-span-parenting`     | Evaluator span parented to call span                                 |
| `tests/evals/test_online.py:2220`           | `evals.test.ts::online-event-parenting`    | Log event parented to call span (NonRecording context)               |
| `tests/evals/test_evaluator_spec.py`        | `evaluatorSpec.test.ts`                    | Three-form short/long round-trip, including ambiguity edge case      |
| `tests/evals/test_otel.py`                  | `spanTree.test.ts`                         | SpanQuery DSL, traversal helpers, HasMatchingSpan                    |

We'll generate the snapshot fixtures by running the Python tests once with `inline_snapshot` and copying the JSON over — that becomes the wire-format ground truth for the TS port. Update them only when Python intentionally changes.

Testing infra additions:

- A small `withMemoryExporter()` test helper in `packages/logfire-api/src/__test__/` that spins up a `BasicTracerProvider` + `InMemorySpanExporter` + (for online) a `LoggerProvider` + `InMemoryLogRecordExporter`. Returns the captured spans/logs after the test body runs.
- We'll wire `serializeAttributes` into the exporter so captured attributes match what the platform actually receives. (The current ad-hoc test in `index.test.ts` `vi.mock`s the tracer; for evals we want the real-export path to catch JSON-schema sidecar issues.)

## 9. Challenges & how we address them

**C1. `noUncheckedIndexedAccess` + heavy generic plumbing.** Python uses ducktype; TS's strict mode will surface every `obj[key]` as `T | undefined`. The Dataset class is generic over `<Inputs, Output, Metadata>`; evaluators consume those generics. We'll keep generics flowing through `EvaluatorContext` and `Case`; for the heterogeneous registry path (where evaluators are loaded from YAML) we'll lose precision and coerce to `Evaluator<unknown, unknown, unknown>` — same as Python's typing-erased load path. Document clearly.

**C2. Evaluator serialization without `@dataclass` introspection.** Static `evaluatorName` + per-class `toJSON()` (default-skipping). Built-ins implement it; users do too if they want disk serialization. Lossless because we don't reflect — explicit beats implicit, and avoids the `keepNames`-via-Vite hack PR #104 used.

**C3. `_spanName` plumbing.** Adding a private `_spanName` option to `LogOptions` for evaluator-span dual emission. Single-line change in `index.ts`/`startSpan`; no public surface change. Tests cover.

**C4. `AsyncLocalStorage` in non-Node runtimes.** Browser doesn't have ALS; CF Workers does (since Workers runtime ~early 2024). For browser, we degrade to per-promise-chain context via `Symbol`-keyed promise hooks — works for the single-execute-at-a-time pattern. Document max concurrency = 1 in browser as a temporary limitation. (This only matters for offline evals; online is fine because the call span is the source of truth, no ALS needed for context propagation.)

**C5. No `@opentelemetry/api-logs` provider in `logfire-node` today.** Adding `gen_ai.evaluation.result` log emission requires a `LoggerProvider` configured against the same OTLP exporter. Investigation needed during Phase 6 — if missing, we add it to `logfire-node` as part of that PR. Likely small (~50 LoC: instantiate provider, register a `BatchLogRecordProcessor` against an `OTLPLogExporter`).

**C6. JSON-schema validation parity.** `pydantic` errors are aggregated and structured; `zod`'s are too, but the formats differ. We'll wrap zod errors into a custom `DatasetParseError` that's grep-friendly across both languages (same error codes for structural mismatches). Won't be byte-identical with Python.

**C7. Hosted-dataset HTTP API.** Python's `LogfireAPIClient` (datasets push/pull) hits `/v1/datasets/*`. **Out of scope for v1.** It's behind the API-key/write-token unification work the company is doing. Note in docs; revisit when token unification lands.

**C8. `LLMJudge` parity.** No pydantic-ai-js exists. We ship BYO-callback only; document the gap. Future: when pydantic-ai-js or a TS-side model gateway lands, wire up a default judge.

**C9. Browser file IO.** `Dataset.fromFile(path)` only works in Node. Browser users use `Dataset.fromText(content, { format: 'yaml' })`. We'll throw a clear runtime error if `fromFile` is called in a non-Node runtime — we detect via `typeof process !== 'undefined' && process.versions?.node`.

**C10. Windows path handling.** `_save_schema` sidecar writing uses `path.parse(file).dir` + `${stem}_schema.json`. Use Node's `path` module (not string concat) so Windows dataset paths work.

**C11. `logfire.experiment.metadata.averages.assertions` must be a numeric.** Easy to accidentally serialize as string. We'll have a unit test that verifies the type at the OTel attribute level using a custom matcher.

**C12. Bool dual-emit on `gen_ai.evaluation.result`.** Easy to forget the `score.label = 'pass'|'fail'`. Already in our spec; we add a unit test that asserts BOTH attributes are set for boolean inputs.

## 10. Out of scope / parking lot

Other non-OTel-wrapper Python `logfire` APIs — for the user's "brief commentary" ask:

| API                                                                                                                 | Verdict                                                                                                                                                                                                       | Reasoning |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `LogfireAPIClient` / `AsyncLogfireAPIClient` (hosted datasets push/pull, `/v1/datasets/*`)                          | **Defer.** Re-evaluate after token unification. Worth it eventually because UI-managed datasets are a real product feature. Auth: API key.                                                                    |
| `LogfireQueryClient` / `AsyncLogfireQueryClient` (`/v1/query`, Arrow/CSV)                                           | **Defer.** Useful for users who want to script Logfire queries from JS, but unrelated to evals. Auth: read token.                                                                                             |
| `LogfireRemoteVariableProvider` (managed variables, `/v1/variables/*`, SSE)                                         | **Defer to dedicated workstream.** This is a separate product feature ("managed variables / feature flags / prompts") and shouldn't be lumped into evals. Auth: API key. SSE adds non-trivial implementation. |
| Device-flow auth (`/v1/device-auth/*`) + `LogfireClient` (CLI bootstrap, project create, write/read token issuance) | **Skip.** This is CLI-only; if/when we ship a TS CLI it'll get its own scoping.                                                                                                                               |
| OTLP forwarding proxy (`logfire_proxy`)                                                                             | **Skip.** Use case is browser/edge → server. Outside evals.                                                                                                                                                   |
| `record_feedback` / annotations                                                                                     | **Skip in this scope.** It's pure span emission, no HTTP. Easy port later (~1 day) if product wants it.                                                                                                       |
| `url_from_eval(report)` helper                                                                                      | **Include.** 3-line helper. We'll add `Logfire.urlFromEval(report)` returning `${projectUrl}/evals/compare?experiment=${trace_id}-${span_id}`.                                                                |

Compatibility concerns for the deferred ones, for record-keeping:

- All three deferred HTTP APIs use auth credentials that are mid-unification on the platform side. Implementing them now means rewriting auth handling shortly after. **Wait until the unified credential lands.**
- Managed Variables in particular has SSE for live updates — straightforward in Node (`node:events`+stream parsing) but flaky in browser (`EventSource` reconnect semantics differ) and effectively unimplemented in CF Workers (no native EventSource). When we do this, plan for the runtime split.
- Hosted datasets push/pull is the single most-likely-to-be-asked-for platform API for evals users. Worth a dedicated follow-up scoping doc once the evals core lands and credentials unify.

## 11. Key parity-oracle file pointers (for the implementer)

- `~/Programming/pydantic/pydantic-ai/pydantic_evals/pydantic_evals/dataset.py` — span emission lines 342–356, 1042–1076, 1108–1160
- `~/Programming/pydantic/pydantic-ai/pydantic_evals/pydantic_evals/_otel_emit.py` — entire file (~240 LoC), port directly
- `~/Programming/pydantic/pydantic-ai/pydantic_evals/pydantic_evals/online.py` + `_online.py` — sampling/sinks/dispatch
- `~/Programming/pydantic/pydantic-ai/pydantic_evals/pydantic_evals/otel/_context_in_memory_span_exporter.py` — span-tree exporter
- `~/Programming/pydantic/pydantic-ai/tests/evals/test_dataset.py:1577–1825` — span snapshot
- `~/Programming/pydantic/pydantic-ai/tests/evals/test_otel_emit.py` — full event encoding
- `~/Programming/pydantic/platform/src/services/fusionfire/src/ingest/experiments.rs:88–200` — experiment span matcher
- `~/Programming/pydantic/platform/src/services/fusionfire/design-docs/active/0008-online-evals-via-otel-events.md` — read end-to-end before Phase 6
- `~/Programming/pydantic/platform/src/services/logfire-frontend/src/packages/evals/schemas.ts:55–102` — strict Zod parser the frontend uses on case spans (mirrors what we must emit)
- `~/Programming/pydantic/platform/src/services/logfire-frontend/src/app/evals/live/hooks/use-live-evals.ts` — UI SQL for online evals (defines what attributes light up the UI)

## 12. Open questions / decisions

1. **Sub-export `logfire/evals` vs flat root export.** Proposing the sub-export to keep `import 'logfire'` lean. Confirm.
2. **Adding `zod` and `js-yaml` to the pnpm catalog.** Both small; necessary for `fromFile`/runtime validation. Confirm.
3. **`evaluatorName` source of truth — static field vs. registry-only.** Proposing `static evaluatorName?: string` defaulting to `class.name`, with a runtime warning when class name differs from a registered name (catches minification bugs). Alternative is registry-only. Mild preference for the static-field approach.
4. **Browser concurrent-execute limitation.** Are we OK telling browser users `maxConcurrency = 1`? If not, we need a richer no-ALS context strategy and Phase 2/3 grow.
5. **Online eval API: HOF (`withOnlineEvaluation(fn, opts)`) vs. TC39 stage-3 decorators (`@evaluate(...)`).** Proposing HOF for v1 — works everywhere, no `experimentalDecorators` required. Decorators can layer on later.
6. **Should `Dataset.evaluate` accept an OTel `Tracer` override** (so users with multiple Logfire projects can route eval data deliberately)? Python doesn't have this; might be useful in TS where multi-tenant SDK setups are common. Default: no, add later if asked.
7. **Where does the docs prose live?** The TS evals docs need to land somewhere — probably an `evals/typescript/` subtree on `logfire.pydantic.dev`. Follow-up workstream once the SDK lands.

## 13. Effort estimate

Roughly **6–7 PRs over ~3–4 weeks of focused work** depending on how aggressive we want to be on parity. The bulk of the surface area (Phase 2 + 3 + 5) is well-understood ports of existing Python code; Phase 4 (serialization) and Phase 6 (online events + LoggerProvider wiring) are the two where surprises are most likely.
