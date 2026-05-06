# Pydantic Logfire — Uncomplicated Observability — JavaScript SDK

From the team behind [Pydantic Validation](https://pydantic.dev/), **Pydantic Logfire** is an observability platform built on the same belief as our open source library — that the most powerful tools can be easy to use.

Check the [Github Repository README](https://github.com/pydantic/logfire-js) for more information on how to use the SDK.

## Evaluations

`logfire/evals` exports the JavaScript evaluation API. It mirrors the
[Python `pydantic-evals`](https://pydantic.dev/docs/ai/evals/evals/) model:
offline `Dataset` experiments, built-in and custom case evaluators,
report-level analyses, YAML/JSON dataset files, and `withOnlineEvaluation` for
sampled live monitoring. The emitted OpenTelemetry span/log format and dataset
file format are compatible with Logfire's evaluations UI.

Use offline evaluation for curated checks before deployment:

```ts
import { Case, Dataset, EqualsExpected, Evaluator, IsInstance, renderReport, type EvaluatorContext } from 'logfire/evals'

interface ClassifyInputs {
  text: string
}

class ConfidenceScore extends Evaluator<ClassifyInputs, string> {
  static evaluatorName = 'ConfidenceScore'

  evaluate(ctx: EvaluatorContext<ClassifyInputs, string>): number {
    return ctx.output === ctx.expectedOutput ? 1 : 0
  }
}

const dataset = new Dataset<ClassifyInputs, string>({
  cases: [
    new Case({ expectedOutput: 'POSITIVE', inputs: { text: 'I love this!' }, name: 'positive-1' }),
    new Case({ expectedOutput: 'NEGATIVE', inputs: { text: 'This failed' }, name: 'negative-1' }),
  ],
  evaluators: [new IsInstance({ typeName: 'string' }), new EqualsExpected(), new ConfidenceScore()],
  name: 'sentiment-classifier',
})

const report = await dataset.evaluate(async ({ text }) => {
  const lower = text.toLowerCase()
  if (lower.includes('love')) return 'POSITIVE'
  if (lower.includes('fail')) return 'NEGATIVE'
  return 'NEUTRAL'
})

console.log(renderReport(report, { includeInput: true, includeOutput: true }))
```

An evaluator may return a `boolean` assertion, `number` score, `string` label,
`{ value, reason }`, or a map of named results. Built-ins include
`EqualsExpected`, `Equals`, `Contains`, `IsInstance`, `MaxDuration`,
`HasMatchingSpan`, and `LLMJudge`. Report evaluators include
`ConfusionMatrixEvaluator`, `PrecisionRecallEvaluator`, `ROCAUCEvaluator`, and
`KolmogorovSmirnovEvaluator`.

Use `setEvalAttribute()` and `incrementEvalMetric()` inside the task to add
per-case data to the report, and use `HasMatchingSpan` when the task must emit
a particular OpenTelemetry span. Use `LLMJudge` for rubric-based checks by
providing a `judge` callback or a process-wide `setDefaultJudge()` function.

Datasets can be saved and loaded in Python-compatible YAML/JSON:

```ts
await dataset.toFile('sentiment.yaml', { schemaPath: 'sentiment.schema.json' })

const restored = await Dataset.fromFile<ClassifyInputs, string>('sentiment.yaml', {
  customEvaluators: [ConfidenceScore],
})
```

Dataset files use Python-compatible field names such as `expected_output`,
`report_evaluators`, `predicted_from`, and snake_case `SpanQuery` keys.
`Dataset.toFile` / `Dataset.fromFile` are available in Node, Bun, and Deno;
browser and Cloudflare Worker runtimes can use in-memory datasets and online
evaluation, but not filesystem-backed helpers.

Use online evaluation to monitor live async functions without blocking callers:

```ts
import { Contains, Evaluator, OnlineEvaluator, waitForEvaluations, withOnlineEvaluation, type EvaluatorContext } from 'logfire/evals'

class NonEmpty extends Evaluator {
  static evaluatorName = 'NonEmpty'

  evaluate(ctx: EvaluatorContext): boolean {
    return String(ctx.output ?? '').length > 0
  }
}

const monitored = withOnlineEvaluation(async (text: string) => `summary: ${text}`, {
  evaluators: [
    new NonEmpty(),
    new OnlineEvaluator({
      evaluator: new Contains({ asStrings: true, caseSensitive: false, value: 'summary' }),
      maxConcurrency: 5,
      sampleRate: 0.1,
    }),
  ],
  extractArgs: ['text'],
  target: 'summarizer',
})

await monitored('hello')
await waitForEvaluations()
```

For online evaluation, JavaScript parameter-name extraction is best effort; use
`extractArgs: ['argName']` for stable `context.inputs` keys in bundled or
minified builds, or `extractArgs: false` to keep positional input values.
`logfire.configure()` from `@pydantic/logfire-node` installs the evals
span-tree processor automatically; custom OpenTelemetry setups can add
`getEvalsSpanProcessor()` from `logfire/evals`.

References and examples:

- [Pydantic Evals overview](https://pydantic.dev/docs/ai/evals/evals/)
- [Evaluator overview](https://pydantic.dev/docs/ai/evals/evaluators/overview/)
- [Dataset management](https://pydantic.dev/docs/ai/evals/how-to/dataset-management/)
- [Report evaluators](https://pydantic.dev/docs/ai/evals/evaluators/report-evaluators/)
- [Online evaluation](https://pydantic.dev/docs/ai/evals/online-evaluation/)
- [`examples/node/evals.ts`](https://github.com/pydantic/logfire-js/blob/main/examples/node/evals.ts)
- [`examples/node/demo_evals.ts`](https://github.com/pydantic/logfire-js/blob/main/examples/node/demo_evals.ts)
- [`examples/node/demo_online_evals.ts`](https://github.com/pydantic/logfire-js/blob/main/examples/node/demo_online_evals.ts)

## Managed Variables

`logfire/vars` exports managed variables for runtime configuration controlled
by local config or the Logfire Variables API. Use `defineVar`, or import the
Python-parity `var` export with an alias because `var` is a JavaScript keyword.

```ts
import { configureVariables, defineVar } from 'logfire/vars'

configureVariables({
  config: {
    variables: {
      feature_enabled: {
        labels: { on: { serialized_value: 'true', version: 1 } },
        name: 'feature_enabled',
        overrides: [],
        rollout: { labels: { on: 1 } },
      },
    },
  },
})

const featureEnabled = defineVar('feature_enabled', { default: false })
const resolved = await featureEnabled.get({ targetingKey: 'user-123' })
```

Remote variables require a Logfire API key and should be used from trusted
server-side runtimes. Do not expose API keys in browser bundles.
