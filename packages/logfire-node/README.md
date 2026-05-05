# Pydantic Logfire — JavaScript SDK

From the team behind [Pydantic Validation](https://pydantic.dev/), **Pydantic Logfire** is an observability platform built on the same belief as our open source library — that the most powerful tools can be easy to use.

What sets Logfire apart:

- **Simple and Powerful:** Logfire's dashboard is simple relative to the power it provides, ensuring your entire engineering team will actually use it.
- **SQL:** Query your data using standard SQL — all the control and (for many) nothing new to learn. Using SQL also means you can query your data with existing BI tools and database querying libraries.
- **OpenTelemetry:** Logfire is an opinionated wrapper around OpenTelemetry, allowing you to leverage existing tooling, infrastructure, and instrumentation for many common packages, and enabling support for virtually any language.

See the [documentation](https://logfire.pydantic.dev/docs/) for more information.

**Feel free to report issues and ask any questions about Logfire in this repository!**

This repo contains the JavaScript Node.js SDK; the server application for recording and displaying data is closed source.

If you need to instrument your browser application, see the [Logfire Browser package](https://www.npmjs.com/package/@pydantic/logfire-browser).
If you're instrumenting Cloudflare, see the [Logfire CF workers package](https://www.npmjs.com/package/@pydantic/logfire-cf-workers).

## Basic usage

Using Logfire from your Node.js script is as simple as
[getting a write token](https://logfire.pydantic.dev/docs/how-to-guides/create-write-tokens/),
installing the package, calling configure, and using the provided API. Let's
create an empty project:

```sh
mkdir test-logfire-js
cd test-logfire-js
npm init -y es6 # creates package.json with `type: module`
npm install @pydantic/logfire-node
```

Then, create the following `hello.js` script in the directory:

```js
import * as logfire from '@pydantic/logfire-node'

logfire.configure({
  token: 'my-write-token', // replace with your write token
  serviceName: 'example-node-script',
  serviceVersion: '1.0.0',
})

logfire.info(
  'Hello from Node.js',
  {
    'attribute-key': 'attribute-value',
  },
  {
    tags: ['example', 'example2'],
  }
)
```

Run the script with `node hello.js`, and you should see the span being logged in
the live view of your Logfire project.

## Resource attributes

Use `resourceAttributes` to attach stable OpenTelemetry resource metadata to all
telemetry emitted by this SDK:

```js
import * as logfire from '@pydantic/logfire-node'

logfire.configure({
  token: 'my-write-token',
  serviceName: 'example-node-script',
  resourceAttributes: {
    'service.namespace': 'my-company',
    'service.instance.id': crypto.randomUUID(),
  },
})
```

First-class options such as `serviceName`, `serviceVersion`, and `environment`
take precedence over conflicting `resourceAttributes` keys. Values from
`OTEL_RESOURCE_ATTRIBUTES` still take precedence over code configuration.

## Evaluations

`logfire/evals` provides offline and online evaluation primitives that emit
OpenTelemetry spans and log events compatible with the Logfire Evaluations UI.
The API mirrors the Python `pydantic-evals` model: define `Case` objects, group
them in a `Dataset`, run a task, and attach evaluators that return assertions,
scores, labels, or multiple named results. Dataset YAML/JSON files round-trip
across Python and JavaScript. Add `logfire` as a direct dependency in projects
that import this subpath.

```ts
import * as logfire from '@pydantic/logfire-node'
import {
  Case,
  Contains,
  Dataset,
  EqualsExpected,
  Evaluator,
  OnlineEvaluator,
  renderReport,
  waitForEvaluations,
  withOnlineEvaluation,
  type EvaluatorContext,
} from 'logfire/evals'

logfire.configure({ serviceName: 'sentiment-classifier' })

async function classify({ text }: { text: string }): Promise<string> {
  return text.toLowerCase().includes('love') ? 'POSITIVE' : 'NEUTRAL'
}

class NonEmpty extends Evaluator {
  static evaluatorName = 'NonEmpty'

  evaluate(ctx: EvaluatorContext): boolean {
    return String(ctx.output ?? '').length > 0
  }
}

// Offline — runs your task against a labeled dataset and emits an experiment span.
const dataset = new Dataset<{ text: string }, string>({
  cases: [new Case({ inputs: { text: 'I love this!' }, expectedOutput: 'POSITIVE', name: 'a' })],
  evaluators: [new EqualsExpected(), new NonEmpty()],
  name: 'sentiment-classifier',
})
const report = await dataset.evaluate(classify)
console.log(renderReport(report, { includeInput: true, includeOutput: true }))

await dataset.toFile('sentiment.yaml', { schemaPath: 'sentiment.schema.json' })

// Online — wraps a function so each call also dispatches evaluators in the background.
const monitored = withOnlineEvaluation(classify, {
  evaluators: [
    new NonEmpty(),
    new OnlineEvaluator({
      evaluator: new Contains({ value: 'POSITIVE' }),
      maxConcurrency: 5,
      sampleRate: 0.1,
    }),
  ],
  extractArgs: ['input'],
  target: 'sentiment-classifier',
})
await monitored({ text: 'I love this!' })
await waitForEvaluations()
```

Built-in case evaluators include `EqualsExpected`, `Equals`, `Contains`,
`IsInstance`, `MaxDuration`, `HasMatchingSpan`, and `LLMJudge`. Built-in report
evaluators include `ConfusionMatrixEvaluator`, `PrecisionRecallEvaluator`,
`ROCAUCEvaluator`, and `KolmogorovSmirnovEvaluator`. Code under evaluation can
also use `setEvalAttribute()` and `incrementEvalMetric()` to add per-case data
to reports.

Runtime notes:

- `Dataset.toFile` / `Dataset.fromFile` work in Node, Bun, and Deno. Browser and
  Cloudflare Worker runtimes can use in-memory datasets and online evaluation,
  but not filesystem-backed dataset helpers.
- Browser offline evaluations should use `maxConcurrency: 1`; without
  `AsyncLocalStorage`, concurrent case runs cannot isolate
  `setEvalAttribute` / `incrementEvalMetric` state.
- Manual non-Node smoke checks live under `scripts/runtime-smoke`:

```sh
pnpm build
deno run --config scripts/runtime-smoke/deno.json --allow-read --allow-write scripts/runtime-smoke/evals-deno.ts
bun run scripts/runtime-smoke/evals-bun.ts
```

References:

- [Pydantic Evals overview](https://pydantic.dev/docs/ai/evals/evals/)
- [Evaluator overview](https://pydantic.dev/docs/ai/evals/evaluators/overview/)
- [Dataset management](https://pydantic.dev/docs/ai/evals/how-to/dataset-management/)
- [Online evaluation](https://pydantic.dev/docs/ai/evals/online-evaluation/)
- [`examples/node/evals.ts`](https://github.com/pydantic/logfire-js/blob/main/examples/node/evals.ts)
- [`examples/node/demo_online_evals.ts`](https://github.com/pydantic/logfire-js/blob/main/examples/node/demo_online_evals.ts)

## Managed Variables

Managed variables are available from `@pydantic/logfire-node/vars` or
`logfire/vars`. Configure Node with `apiKey` or `LOGFIRE_API_KEY` to use the
remote Logfire provider.

```ts
import * as logfire from '@pydantic/logfire-node'
import { defineVar } from '@pydantic/logfire-node/vars'

logfire.configure({
  apiKey: process.env.LOGFIRE_API_KEY,
  serviceName: 'example-node-script',
  variables: { pollingInterval: 60 },
})

const featureEnabled = defineVar('feature_enabled', { default: false })
const resolved = await featureEnabled.get({ targetingKey: 'user-123' })
```

Use local variables for tests and development without network access.

## Contributing

See [CONTRIBUTING.md](https://github.com/pydantic/logfire-js/blob/main/CONTRIBUTING.md) for development instructions.

## License

MIT
