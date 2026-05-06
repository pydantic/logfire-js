# Pydantic Logfire — JavaScript SDK

From the team behind [Pydantic Validation](https://pydantic.dev/), **Pydantic Logfire** is an observability platform built on the same belief as our open source library — that the most powerful tools can be easy to use.

What sets Logfire apart:

- **Simple and Powerful:** Logfire's dashboard is simple relative to the power it provides, ensuring your entire engineering team will actually use it.
- **SQL:** Query your data using standard SQL — all the control and (for many) nothing new to learn. Using SQL also means you can query your data with existing BI tools and database querying libraries.
- **OpenTelemetry:** Logfire is an opinionated wrapper around OpenTelemetry, allowing you to leverage existing tooling, infrastructure, and instrumentation for many common packages, and enabling support for virtually any language. We offer full support for all OpenTelemetry signals (traces, metrics, and logs).

**Feel free to report issues and ask any questions about Logfire in this repository!**

This repository contains the JavaScript SDK for `logfire` and its documentation; the server application for recording and displaying data is closed source.

<img width="1394" alt="Logfire UI with Next.js traces" src="https://github.com/user-attachments/assets/a2a1167b-6bf7-4d6a-8d59-81cb2433c8e9" />

Depending on your environment, you can integrate Logfire in several ways. Follow
the specific instructions below:

## Basic Node.js script

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
  token: 'test-e2e-write-token',
  advanced: {
    baseUrl: 'http://localhost:3000',
  },
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

## Cloudflare Workers

First, install the `@pydantic/logfire-cf-workers logfire` NPM
packages:

```sh
npm install @pydantic/logfire-cf-workers logfire
```

Next, add `compatibility_flags = [ "nodejs_compat" ]` to your wrangler.toml or
`"compatibility_flags": ["nodejs_compat"]` if you're using `wrangler.jsonc`.

Add your
[Logfire write token](https://logfire.pydantic.dev/docs/how-to-guides/create-write-tokens/)
to your `.dev.vars` file:

```sh
LOGFIRE_TOKEN=your-write-token
LOGFIRE_ENVIRONMENT=development
```

The `LOGFIRE_ENVIRONMENT` variable is optional and can be used to specify the environment for the service.

For production deployment, check the
[Cloudflare documentation for details on managing and deploying secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

One way to do this is through the `npx wrangler` command:

```sh
npx wrangler secret put LOGFIRE_TOKEN
```

Next, add the necessary instrumentation around your handler. The `tracerConfig`
function will extract your write token from the `env` object and provide the
necessary configuration for the instrumentation:

```ts
import * as logfire from 'logfire'
import { instrument } from '@pydantic/logfire-cf-workers'

const handler = {
  async fetch(): Promise<Response> {
    logfire.info('info span from inside the worker body')
    return new Response('hello world!')
  },
} satisfies ExportedHandler

export default instrument(handler, {
  service: {
    name: 'my-cloudflare-worker',
    namespace: '',
    version: '1.0.0',
  },
})
```

A working example can be found in the `examples/cloudflare-worker` directory.

Note: if you're testing your worker with Vitest, you need to add the following additional configuration to your `vitest.config.mts`:

```ts
export default defineWorkersConfig({
  test: {
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ['@pydantic/logfire-cf-workers'],
        },
      },
    },
    poolOptions: {
      workers: {
        // ...
      },
    },
  },
})
```

## Next.js/Vercel

Vercel provides a comprehensive OpenTelemetry integration through the
`@vercel/otel` package. After following
[their integration instructions](https://vercel.com/docs/otel), add the
following environment variables to your project:

```sh
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://logfire-api.pydantic.dev/v1/traces
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://logfire-api.pydantic.dev/v1/metrics
OTEL_EXPORTER_OTLP_HEADERS='Authorization=your-write-token'
```

This will point the instrumentation to Logfire.

> [!NOTE]
> Vercel production deployments have a caching mechanism that might prevent
> changes from taking effect immediately or spans from being reported. If you
> are not seeing spans in Logfire, you can
> [clear the data cache for your project](https://vercel.com/docs/data-cache/manage-data-cache).

Optionally, you can use the Logfire API package for creating manual spans.
Install the `logfire` NPM package and call the respective methods
from your server-side code:

```tsx
import * as logfire from 'logfire'

export default async function Home() {
  return logfire.span(
    'A warning span',
    {},
    {
      level: logfire.Level.Warning,
    },
    async (span) => {
      logfire.info('Nested info span')
      return <div>Hello</div>
    }
  )
}
```

A working example can be found in the `examples/nextjs` directory.

### Next.js client-side instrumentation

The `@vercel/otel` package does not support client-side instrumentation, so few additional steps are necessary to send spans and/or instrument the client-side.
For a working example, refer to the `examples/nextjs-client-side-instrumentation` directory, which instruments the client-side `fetch` calls.

## Express, generic Node instrumentation

For this example, we will instrument a simple Express app:

```ts
/*app.ts*/
import express, type { Express } from 'express';

const PORT: number = parseInt(process.env.PORT || '8080');
const app: Express = express();

function getRandomNumber(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

app.get('/rolldice', (req, res) => {
  res.send(getRandomNumber(1, 6).toString());
});

app.listen(PORT, () => {
  console.log(`Listening for requests on http://localhost:${PORT}`);
});
```

Next, install the `@pydantic/logfire-node` and `dotenv` NPM packages to keep your Logfire write
token in a `.env` file:

```sh
npm install @pydantic/logfire-node dotenv
```

Add your token to the `.env` file:

```sh
LOGFIRE_TOKEN=your-write-token
```

Then, create an `instrumentation.ts` file to set up the instrumentation. The
`@pydantic/logfire-node` package includes a `configure` function that simplifies the setup:

```ts
// instrumentation.ts
import * as logfire from '@pydantic/logfire-node'
import 'dotenv/config'

logfire.configure()
```

The `logfire.configure` call should happen before the actual express module
imports, so your NPM start script should look like this (`package.json`):

```json
"scripts": {
  "start": "npx ts-node --require ./instrumentation.ts app.ts"
},
```

## Deno

Deno has
[built-in support for OpenTelemetry](https://docs.deno.com/runtime/fundamentals/open_telemetry/).
The examples directory includes a `Hello world` example that configures Deno
OTel export to Logfire through environment variables.

Optionally, you can use the Logfire API package for creating manual spans.
Install the `logfire` NPM package and call the respective methods
from your code.

## Evaluations

The `logfire/evals` subpath provides code-first evaluation APIs for JavaScript
and TypeScript. It mirrors the data model and serialized dataset format from
[Python `pydantic-evals`](https://pydantic.dev/docs/ai/evals/evals/): define
cases in code or YAML/JSON, run a task as an offline experiment, attach
evaluators, and view the emitted OpenTelemetry data in Logfire.

Use offline `Dataset.evaluate()` for curated pre-deployment checks, and
`withOnlineEvaluation()` for sampled production or staging monitoring. Add
`logfire` as a direct dependency in projects that import this subpath. To send
evaluation traces and log events to Logfire from Node.js, configure
`@pydantic/logfire-node` before running evals.

```ts
import * as logfire from '@pydantic/logfire-node'

logfire.configure()
```

### Core model

- `Case` is one scenario: inputs, optional expected output, metadata, and
  optional case-specific evaluators.
- `Dataset` groups cases and shared evaluators for one task.
- A task is the function being evaluated.
- `Evaluator` instances inspect each task result and return assertions, scores,
  labels, or multiple named results.
- `EvaluationReport` contains successful case results, failures, averages, and
  report-level analyses.

### Offline experiments

An offline experiment runs every case through the task, applies case-specific
evaluators first, then dataset-level evaluators, and returns a report.

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

interface CaseMetadata {
  category: 'happy' | 'failure' | 'neutral'
}

async function classify({ text }: ClassifyInputs): Promise<string> {
  const lower = text.toLowerCase()
  if (lower.includes('error') || lower.includes('fail')) return 'NEGATIVE'
  if (lower.includes('great') || lower.includes('love')) return 'POSITIVE'
  return 'NEUTRAL'
}

class StartsWithExpected extends Evaluator<ClassifyInputs, string, CaseMetadata> {
  static evaluatorName = 'StartsWithExpected'

  evaluate(ctx: EvaluatorContext<ClassifyInputs, string, CaseMetadata>): number {
    if (ctx.expectedOutput === undefined) return 0
    return ctx.output.startsWith(ctx.expectedOutput) ? 1 : 0
  }
}

const dataset = new Dataset<ClassifyInputs, string, CaseMetadata>({
  cases: [
    new Case<ClassifyInputs, string, CaseMetadata>({
      expectedOutput: 'POSITIVE',
      inputs: { text: 'I love this!' },
      metadata: { category: 'happy' },
      name: 'positive-1',
    }),
    new Case<ClassifyInputs, string, CaseMetadata>({
      expectedOutput: 'NEGATIVE',
      inputs: { text: 'This failed' },
      metadata: { category: 'failure' },
      name: 'negative-1',
    }),
    new Case<ClassifyInputs, string, CaseMetadata>({
      evaluators: [new Contains({ value: 'POSITIVE' })],
      expectedOutput: 'POSITIVE',
      inputs: { text: 'it is great' },
      metadata: { category: 'happy' },
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
  taskName: 'classify',
})

console.log(renderReport(report, { includeInput: true, includeOutput: true }))
```

`Dataset.evaluate()` also accepts `metadata`, `name`, `repeat`, `signal`,
`retryEvaluators`, `lifecycle`, and a custom progress callback.

Cases and evaluators can also be assembled incrementally, which is useful when
you generate cases from fixtures or load only part of a suite for a smoke test:

```ts
import { Dataset, EqualsExpected, MaxDuration } from 'logfire/evals'

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
smokeDataset.addCase({
  expectedOutput: 'NEGATIVE',
  inputs: { text: 'checkout failed' },
  name: 'checkout-negative',
})
smokeDataset.addEvaluator(new MaxDuration({ seconds: 1 }))

const smokeReport = await smokeDataset.evaluate(classify, { maxConcurrency: 2 })
```

### Evaluator outputs

Custom evaluators can be synchronous or asynchronous. Their return type controls
how results are grouped in the report and Logfire UI:

- `boolean` becomes a pass/fail assertion.
- `number` becomes a numeric score.
- `string` becomes a categorical label.
- `{ value, reason }` adds an explanation to a scalar result.
- `{ key: value, ... }` emits multiple named results from one evaluator.

If an evaluator throws, the failure is recorded on the case without stopping the
whole experiment.

The built-in case evaluators cover common checks:

| Evaluator         | Use                                                                 |
| ----------------- | ------------------------------------------------------------------- |
| `EqualsExpected`  | Compare output with `Case.expectedOutput`.                          |
| `Equals`          | Compare output with a fixed value.                                  |
| `Contains`        | Check substring, array membership, or object key/value containment. |
| `IsInstance`      | Check the runtime constructor name or primitive type.               |
| `MaxDuration`     | Assert the task finished within a duration.                         |
| `HasMatchingSpan` | Assert the task emitted a span matching a `SpanQuery`.              |
| `LLMJudge`        | Run a user-provided judge callback against a rubric.                |

`LLMJudge` does not bundle a model client. Pass a `judge` callback per instance
or call `setDefaultJudge()` once at startup.

### LLM-as-a-judge

Use `LLMJudge` when the desired behavior is subjective or rubric-based. The
JavaScript SDK deliberately does not choose a model provider; wire the judge
callback to your model client and return `{ pass, score, reason }`.

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

### Attributes, metrics, and spans

Code under evaluation can record custom per-case attributes and numeric metrics
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

### Report evaluators

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

### Dataset files

Datasets can be created in code or loaded from YAML/JSON files. File helpers are
available in Node, Bun, and Deno:

```ts
await dataset.toFile('sentiment.yaml', {
  schemaPath: 'sentiment.schema.json',
})

const restored = await Dataset.fromFile<ClassifyInputs, string, CaseMetadata>('sentiment.yaml', {
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

`toText()`, `fromText()`, `toObject()`, `fromObject()`, and `jsonSchema()` are
also available. Custom evaluators that need to round-trip through YAML/JSON
should set a stable `static evaluatorName` and implement `toJSON()` when their
constructor needs arguments.

Dataset YAML/JSON uses Python-compatible field names for portable files, for
example `expected_output`, `report_evaluators`, `predicted_from`,
`expected_from`, and snake_case `SpanQuery` keys. Built-in evaluator
constructors accept both idiomatic camelCase and serialized snake_case options.

### Online evaluation

Online evaluation wraps an async function and runs evaluators in the background
after each sampled call. Results are emitted as `gen_ai.evaluation.result`
OpenTelemetry log events, and optional sinks can receive the same results in
process.

```ts
import {
  configureOnlineEvals,
  Contains,
  Evaluator,
  OnlineEvaluator,
  waitForEvaluations,
  withOnlineEvaluation,
  type EvaluatorContext,
} from 'logfire/evals'

configureOnlineEvals({
  metadata: { deployment: 'staging' },
  samplingMode: 'correlated',
})

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
error handling. `samplingMode: 'independent'` samples each evaluator
separately; `samplingMode: 'correlated'` uses one random draw per call so
lower-rate evaluators are a subset of higher-rate evaluators.

Online evaluator `context.inputs` is built from JavaScript function parameter
names when they can be inspected. Pass `extractArgs: ['name', ...]` when
bundled or minified code needs stable input names, or `extractArgs: false` to
keep positional input values.

### Runtime notes

- Browser and Cloudflare Worker usage is limited to in-memory datasets and
  online evaluation; filesystem-backed dataset helpers are not available.
- Browser offline runs should keep `maxConcurrency: 1` because there is no
  `AsyncLocalStorage` equivalent for isolating case attributes and metrics.
- `withOnlineEvaluation()` supports async-returning functions.
- `logfire.configure()` auto-installs the evals span-tree processor. If you use
  your own `TracerProvider`, add `getEvalsSpanProcessor()` from
  `logfire/evals`.
- Runnable examples live in `examples/node/evals.ts`,
  `examples/node/demo_evals.ts`, and `examples/node/demo_online_evals.ts`.

### References

These Python Pydantic Evals pages are the conceptual reference for the
JavaScript API shape:

- [Pydantic Evals overview](https://pydantic.dev/docs/ai/evals/evals/)
- [Evaluator overview](https://pydantic.dev/docs/ai/evals/evaluators/overview/)
- [Dataset management](https://pydantic.dev/docs/ai/evals/how-to/dataset-management/)
- [Report evaluators](https://pydantic.dev/docs/ai/evals/evaluators/report-evaluators/)
- [Online evaluation](https://pydantic.dev/docs/ai/evals/online-evaluation/)

Local runnable JavaScript examples:

- [`examples/node/evals.ts`](examples/node/evals.ts)
- [`examples/node/demo_evals.ts`](examples/node/demo_evals.ts)
- [`examples/node/demo_online_evals.ts`](examples/node/demo_online_evals.ts)
- [`scripts/runtime-smoke/README.md`](scripts/runtime-smoke/README.md)

### Configuring the instrumentation

The `logfire.configure` function accepts a set of configuration options that
control the behavior of the instrumentation. Alternatively, you can
[use environment variables](https://logfire.pydantic.dev/docs/reference/configuration/#programmatically-via-configure)
to configure the instrumentation.

## Trace API

The `logfire` package exports several convenience wrappers around the
OpenTelemetry span creation API. The `@pydantic/logfire-node` package re-exports these.

The following methods create spans with their respective log levels (ordered by
severity):

- `logfire.trace`
- `logfire.debug`
- `logfire.info`
- `logfire.notice`
- `logfire.warn`
- `logfire.error`
- `logfire.fatal`

Each method accepts a message, attributes, and optionally, options that let you
specify the span tags. The attribute values must be serializable to JSON.

```ts
function info(message: string, attributes?: Record<string, unknown>, options?: LogOptions): void
```

### Nesting spans

`logfire.span` is a convenience wrapper around the OpenTelemetry span creation API that allows you to create a span and execute a callback function within that span's context.
This is useful for creating nested spans or for executing code within the context of a span. Unlike the opentelemetry implementation, the parent span is automatically ended when the callback function completes.

```ts
logfire.span('parent sync span overload', {
  callback: (_span) => {
    logfire.info('nested span')
  },
})
```

You can also pass parent spans manually through the `parentSpan` option:

```ts
const mySpan = logfire.startSpan('a manual parent span')

logfire.info('manual child span', {}, { parentSpan: mySpan })

// ensure to end the parent span when done
mySpan.end()
```

### Reporting errors

In addition to `trace`, `debug`, the Logfire API exports a `reportError` function that accepts a message and a JavaScript `Error` object. It will extract the necessary details from the error and create a span with the `error` level.

```ts
try {
  1 / 0
} catch (error) {
  logfire.reportError('An error occurred', error)
}
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development instructions.

## License

MIT
