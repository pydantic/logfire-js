---
title: Evaluations
description: Use logfire/evals for offline datasets, online evaluation, built-in evaluators, report evaluators, and Python-compatible dataset files.
---

# Evaluations

`logfire/evals` provides JavaScript and TypeScript evaluation primitives for
offline experiments and sampled online monitoring. The API mirrors the Python
[`pydantic-evals`](https://pydantic.dev/docs/ai/evals/evals/) model: define
cases, group them in a dataset, run a task, attach evaluators, and emit
Logfire-compatible OpenTelemetry spans and log events.

Use offline evaluations before deployment to check a curated dataset. Use online
evaluations in staging or production to sample real calls without blocking the
caller.

## Install

Add `logfire` as a direct dependency when importing the evals subpath:

```bash
npm install logfire
```

In Node.js applications, configure `@pydantic/logfire-node` before running evals
so experiment spans and online evaluation events are exported:

```ts
import * as logfire from '@pydantic/logfire-node'

logfire.configure({
  serviceName: 'sentiment-evals',
})
```

## Core Model

- `Case` is one example: inputs, optional expected output, metadata, and
  optional case-specific evaluators.
- `Dataset` groups cases and dataset-level evaluators for one task.
- The task is the function under evaluation.
- `Evaluator` instances inspect the task result and return assertions, scores,
  labels, or multiple named results.
- `EvaluationReport` contains successful case results, failures, averages, and
  report-level analyses.

## Offline Evaluation

```ts
import {
  Case,
  Contains,
  Dataset,
  EqualsExpected,
  Evaluator,
  IsInstance,
  MaxDuration,
  renderReport,
  type EvaluatorContext,
} from 'logfire/evals'

interface ClassifyInputs {
  text: string
}

async function classify({ text }: ClassifyInputs): Promise<string> {
  const lower = text.toLowerCase()
  if (lower.includes('error') || lower.includes('fail')) return 'NEGATIVE'
  if (lower.includes('great') || lower.includes('love')) return 'POSITIVE'
  return 'NEUTRAL'
}

class StartsWithExpected extends Evaluator<ClassifyInputs, string> {
  static evaluatorName = 'StartsWithExpected'

  evaluate(ctx: EvaluatorContext<ClassifyInputs, string>): number {
    if (ctx.expectedOutput === undefined) return 0
    return ctx.output.startsWith(ctx.expectedOutput) ? 1 : 0
  }
}

const dataset = new Dataset<ClassifyInputs, string>({
  cases: [
    new Case({ expectedOutput: 'POSITIVE', inputs: { text: 'I love this!' }, name: 'positive-1' }),
    new Case({ expectedOutput: 'NEGATIVE', inputs: { text: 'This failed' }, name: 'negative-1' }),
    new Case({
      evaluators: [new Contains({ value: 'POSITIVE' })],
      expectedOutput: 'POSITIVE',
      inputs: { text: 'it is great' },
      name: 'case-specific-check',
    }),
  ],
  evaluators: [new IsInstance({ typeName: 'string' }), new EqualsExpected(), new MaxDuration({ seconds: 2 }), new StartsWithExpected()],
  name: 'sentiment-classifier',
})

const report = await dataset.evaluate(classify, {
  maxConcurrency: 4,
  progress: true,
  retryTask: { retries: 2 },
})

console.log(renderReport(report, { includeInput: true, includeOutput: true }))
```

`Dataset.evaluate()` also accepts `metadata`, `name`, `repeat`, `signal`,
`retryEvaluators`, `lifecycle`, and a custom progress callback.

Cases can be assembled incrementally:

```ts
const smokeDataset = new Dataset<ClassifyInputs, string>({
  cases: [],
  evaluators: [new EqualsExpected()],
  name: 'sentiment-smoke',
})

smokeDataset.addCase({
  expectedOutput: 'POSITIVE',
  inputs: { text: 'great support experience' },
  name: 'support-positive',
})
smokeDataset.addEvaluator(new MaxDuration({ seconds: 1 }))

const smokeReport = await smokeDataset.evaluate(classify, { maxConcurrency: 2 })
```

## Evaluator Outputs

Custom evaluators can be synchronous or asynchronous. Their return type controls
how results are grouped in the report and in Logfire:

- `boolean` becomes a pass/fail assertion.
- `number` becomes a numeric score.
- `string` becomes a categorical label.
- `{ value, reason }` adds an explanation to a scalar result.
- `{ key: value, ... }` emits multiple named results from one evaluator.

If an evaluator throws, the failure is recorded on the case without stopping the
whole experiment.

Built-in case evaluators include:

| Evaluator         | Use                                                                 |
| ----------------- | ------------------------------------------------------------------- |
| `EqualsExpected`  | Compare output with `Case.expectedOutput`.                          |
| `Equals`          | Compare output with a fixed value.                                  |
| `Contains`        | Check substring, array membership, or object key/value containment. |
| `IsInstance`      | Check the runtime constructor name or primitive type.               |
| `MaxDuration`     | Assert the task finished within a duration.                         |
| `HasMatchingSpan` | Assert the task emitted a span matching a `SpanQuery`.              |
| `LLMJudge`        | Run a user-provided judge callback against a rubric.                |

## LLM-as-a-Judge

`LLMJudge` handles subjective or rubric-based checks. The SDK does not bundle a
model client. Pass a `judge` callback per evaluator or configure a default judge
once at startup.

```ts
import { Case, Dataset, LLMJudge, setDefaultJudge } from 'logfire/evals'

setDefaultJudge(async ({ output, rubric }) => {
  const text = String(output)
  const pass = text.includes('because')
  return {
    pass,
    reason: pass ? 'The answer includes an explanation.' : `Missing explanation for rubric: ${rubric}`,
    score: pass ? 1 : 0,
  }
})

const explanationDataset = new Dataset<{ question: string }, string>({
  cases: [
    new Case({
      expectedOutput: 'Photosynthesis uses sunlight to make sugar.',
      inputs: { question: 'Why do plants need sunlight?' },
      name: 'photosynthesis-explanation',
    }),
  ],
  evaluators: [
    new LLMJudge({
      assertion: { evaluationName: 'judge_pass' },
      includeExpectedOutput: true,
      includeInput: true,
      rubric: 'The response answers the question and explains the reasoning.',
      score: { evaluationName: 'judge_score' },
    }),
  ],
  name: 'explanation-quality',
})
```

## Attributes, Metrics, and Spans

Code under evaluation can add custom per-case attributes and numeric metrics
with `setEvalAttribute()` and `incrementEvalMetric()`. Evaluators can also
inspect spans emitted by the task with `HasMatchingSpan`, which is useful when
correctness depends on an internal behavior such as a tool call, cache hit, or
retrieval step.

```ts
import * as logfire from '@pydantic/logfire-node'
import { Case, Dataset, HasMatchingSpan, incrementEvalMetric, setEvalAttribute } from 'logfire/evals'

const loaderDataset = new Dataset<{ userId: string }, string>({
  cases: [new Case({ inputs: { userId: 'user-123' }, name: 'cache-hit' })],
  evaluators: [
    new HasMatchingSpan({
      query: {
        hasAttributes: { cache_hit: true },
        nameEquals: 'load user',
      },
    }),
  ],
  name: 'user-loader',
})

await loaderDataset.evaluate(async ({ userId }) => {
  return logfire.span('load user', { cache_hit: true, user_id: userId }, {}, async () => {
    setEvalAttribute('cache_policy', 'read-through')
    incrementEvalMetric('cache_hits', 1)
    return 'Alice'
  })
})
```

## Report Evaluators

Report evaluators run once after all cases complete and add experiment-wide
analyses to `report.analyses`. When Logfire is configured, these analyses are
attached to the experiment span for visualization.

```ts
import { Case, ConfusionMatrixEvaluator, Dataset, EqualsExpected } from 'logfire/evals'

const animalDataset = new Dataset<string, string>({
  cases: [
    new Case({ expectedOutput: 'cat', inputs: 'The cat goes meow', name: 'cat' }),
    new Case({ expectedOutput: 'dog', inputs: 'The dog barks', name: 'dog' }),
  ],
  evaluators: [new EqualsExpected()],
  name: 'animal-classifier',
  reportEvaluators: [
    new ConfusionMatrixEvaluator({
      expectedFrom: 'expected_output',
      predictedFrom: 'output',
      title: 'Animal classification',
    }),
  ],
})

const animalReport = await animalDataset.evaluate((text) => {
  const lower = text.toLowerCase()
  if (lower.includes('cat') || lower.includes('meow')) return 'cat'
  if (lower.includes('dog') || lower.includes('bark')) return 'dog'
  return 'unknown'
})

console.log(animalReport.analyses)
```

Built-in report evaluators include `ConfusionMatrixEvaluator`,
`PrecisionRecallEvaluator`, `ROCAUCEvaluator`, and
`KolmogorovSmirnovEvaluator`.

## Dataset Files

Dataset file helpers are available in Node.js, Bun, and Deno:

```ts
await dataset.toFile('sentiment.yaml', {
  schemaPath: 'sentiment.schema.json',
})

const restored = await Dataset.fromFile<ClassifyInputs, string>('sentiment.yaml', {
  customEvaluators: [StartsWithExpected],
})
```

The same dataset can be maintained directly as YAML:

```yaml
# yaml-language-server: $schema=sentiment.schema.json
name: sentiment-classifier
cases:
  - name: positive-1
    inputs:
      text: I love this!
    expected_output: POSITIVE
  - name: negative-1
    inputs:
      text: This failed
    expected_output: NEGATIVE
evaluators:
  - EqualsExpected
  - IsInstance: string
report_evaluators:
  - ConfusionMatrixEvaluator:
      predicted_from: output
      expected_from: expected_output
```

Dataset YAML/JSON uses Python-compatible field names for portable files, for
example `expected_output`, `report_evaluators`, `predicted_from`,
`expected_from`, and snake_case `SpanQuery` keys. Custom evaluators that need to
round-trip through YAML/JSON should set a stable `static evaluatorName` and
implement `toJSON()` when their constructor needs arguments.

## Online Evaluation

Online evaluation wraps an async function and runs evaluators in the background
after each sampled call. Results are emitted as `gen_ai.evaluation.result`
OpenTelemetry log events, and optional sinks can receive the same results in
process.

```ts
import { Contains, Evaluator, OnlineEvaluator, waitForEvaluations, withOnlineEvaluation, type EvaluatorContext } from 'logfire/evals'

class NonEmpty extends Evaluator {
  static evaluatorName = 'NonEmpty'

  evaluate(ctx: EvaluatorContext): boolean {
    return String(ctx.output ?? '').length > 0
  }
}

async function summarize(text: string): Promise<string> {
  return `summary: ${text.slice(0, 80)}`
}

const monitoredSummarize = withOnlineEvaluation(summarize, {
  evaluators: [
    new NonEmpty(),
    new OnlineEvaluator({
      evaluator: new Contains({ asStrings: true, caseSensitive: false, value: 'summary' }),
      maxConcurrency: 5,
      sampleRate: 0.1,
    }),
  ],
  extractArgs: ['text'],
  sink: ({ failures, results, target }) => {
    if (failures.length > 0) console.warn(`${target}: ${failures.length} evaluator failures`)
    for (const result of results) console.log(`${result.name}: ${String(result.value)}`)
  },
  target: 'summarizer',
})

await monitoredSummarize('Logfire collects OpenTelemetry data.')
await waitForEvaluations()
```

Pass bare `Evaluator` instances to use the default sample rate, or wrap them in
`OnlineEvaluator` for per-evaluator `sampleRate`, `maxConcurrency`, `sink`, or
error handling. `samplingMode: 'independent'` samples each evaluator separately;
`samplingMode: 'correlated'` uses one random draw per call so lower-rate
evaluators are a subset of higher-rate evaluators.

Online evaluator `context.inputs` is built from JavaScript function parameter
names when they can be inspected. Pass `extractArgs: ['name', ...]` when bundled
or minified code needs stable input names, or `extractArgs: false` to keep
positional input values.

## Runtime Notes

- Browser and Cloudflare Worker usage is limited to in-memory datasets and
  online evaluation; filesystem-backed dataset helpers are not available.
- Browser offline runs should keep `maxConcurrency: 1` because there is no
  `AsyncLocalStorage` equivalent for isolating case attributes and metrics.
- `withOnlineEvaluation()` supports async-returning functions.
- `logfire.configure()` auto-installs the evals span-tree processor. If you use
  your own OpenTelemetry `TracerProvider`, add `getEvalsSpanProcessor()` from
  `logfire/evals`.

## References

Pydantic Evals reference docs:

- [Pydantic Evals overview](https://pydantic.dev/docs/ai/evals/evals/)
- [Evaluator overview](https://pydantic.dev/docs/ai/evals/evaluators/overview/)
- [Dataset management](https://pydantic.dev/docs/ai/evals/how-to/dataset-management/)
- [Report evaluators](https://pydantic.dev/docs/ai/evals/evaluators/report-evaluators/)
- [Online evaluation](https://pydantic.dev/docs/ai/evals/online-evaluation/)

Local runnable examples:

- [`examples/node/evals.ts`](https://github.com/pydantic/logfire-js/blob/main/examples/node/evals.ts)
- [`examples/node/demo_evals.ts`](https://github.com/pydantic/logfire-js/blob/main/examples/node/demo_evals.ts)
- [`examples/node/demo_online_evals.ts`](https://github.com/pydantic/logfire-js/blob/main/examples/node/demo_online_evals.ts)
