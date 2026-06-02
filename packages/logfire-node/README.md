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
When `serviceName` or `serviceVersion` is omitted, Node reads
`LOGFIRE_SERVICE_NAME` / `LOGFIRE_SERVICE_VERSION` first, then falls back to
`OTEL_SERVICE_NAME` / `OTEL_SERVICE_VERSION`.

## Baggage span attributes

Use `baggage.spanAttributes` to copy selected active OpenTelemetry baggage
values onto Logfire manual spans and logs:

```js
import * as logfire from '@pydantic/logfire-node'

logfire.configure({
  serviceName: 'example-node-script',
  baggage: {
    spanAttributes: ['tenant', 'region'],
  },
})
```

Projection is disabled by default and allowlisted. Configured baggage key
`tenant` is emitted as `baggage.tenant`. Explicit span attributes win on
conflict, missing keys are ignored, and values are truncated to 1000
characters. Do not store secrets, credentials, session cookies, raw emails, or
other sensitive user data in baggage because baggage propagates across service
boundaries.

## Minimum level filtering

Use `minLevel` to suppress low-severity manual Logfire telemetry before spans
are created:

```js
import * as logfire from '@pydantic/logfire-node'

logfire.configure({
  serviceName: 'example-node-script',
  minLevel: 'warning',
})
```

Node.js also reads `LOGFIRE_MIN_LEVEL` when code configuration omits
`minLevel`. Code configuration takes precedence, and `minLevel: null` clears a
previous setting. Invalid environment values are warned about and ignored.

Log helpers and `reportError()` are filtered by their level. Duration-style APIs
such as `span()`, `startSpan()`, `startPendingSpan()`, and `instrument()` are
filtered only when the call or scoped client sets an explicit level.

## Console output

Use `console: true` to print spans to the console while developing. Console
output defaults to a minimum level of `info`, matching Python's console
behavior:

```js
import * as logfire from '@pydantic/logfire-node'

logfire.configure({
  serviceName: 'example-node-script',
  console: true,
})
```

To change console output without changing which telemetry is created, pass
object-style console options:

```js
logfire.configure({
  serviceName: 'example-node-script',
  console: {
    minLevel: 'warning',
    includeTags: true,
    includeTimestamps: false,
  },
})
```

Use `console: { minLevel: 'debug' }` or `console: { minLevel: 'trace' }` when
you want lower-severity spans printed locally. `LOGFIRE_CONSOLE=true` remains a
boolean enable switch and uses the default `info` console minimum.

Spans without a Logfire level, including ordinary auto-instrumentation spans,
are treated as `info` for console filtering. Setting `console.minLevel` above
`info` hides those spans from local console output.

## Flush and shutdown

Logfire batches telemetry through OpenTelemetry processors. For short-lived
scripts, tests, CLIs, and graceful process shutdown, explicitly shut down the
SDK before exiting:

```js
import * as logfire from '@pydantic/logfire-node'

logfire.configure({ token: 'my-write-token' })

try {
  logfire.info('work finished')
} finally {
  await logfire.shutdown({ timeoutMillis: 5000 })
}
```

`shutdown()` defaults to flushing first and then closes the underlying
OpenTelemetry SDK. Use `shutdown({ flush: false })` only when you have already
flushed or need to skip the explicit pre-shutdown flush.

Use `forceFlush()` when the process should keep running but queued telemetry
needs to be sent immediately:

```js
await logfire.forceFlush({ timeoutMillis: 5000 })
```

`forceFlush()` drains the Logfire-managed span, log, evaluation, metric-reader,
and additional span processor paths without shutting down the SDK.

### Process hooks

Logfire installs process hooks for `beforeExit`, `SIGTERM`,
`uncaughtExceptionMonitor`, and `unhandledRejection`.

On `beforeExit`, Logfire runs a bounded best-effort shutdown. On `SIGTERM`,
Logfire also runs bounded best-effort shutdown. If Logfire's listener is the
only `SIGTERM` listener, it then re-emits the signal with
`process.kill(process.pid, 'SIGTERM')` so Node keeps signal-style termination.
If your application installs its own `SIGTERM` handler, Logfire leaves process
termination to that application-level lifecycle code.

Logfire does not install a `SIGINT` handler and does not hook `process.on('exit',
...)`, because async telemetry flush cannot complete from the synchronous
`exit` event.

`uncaughtExceptionMonitor` observes and reports uncaught exceptions without
changing Node's default crash behavior. Any telemetry flush scheduled from that
hook is best-effort only. `unhandledRejection` observes, reports, and flushes on
the current Logfire path; this SDK does not restore Node's default fatal
unhandled-rejection behavior.

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
