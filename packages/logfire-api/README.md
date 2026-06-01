# Pydantic Logfire — Uncomplicated Observability — JavaScript SDK

From the team behind [Pydantic Validation](https://pydantic.dev/), **Pydantic Logfire** is an observability platform built on the same belief as our open source library — that the most powerful tools can be easy to use.

Check the [Github Repository README](https://github.com/pydantic/logfire-js) for more information on how to use the SDK.

## Scoped manual clients

Use `withTags()` or `withSettings()` when several manual spans or logs share
stable defaults:

```ts
import * as logfire from 'logfire'

const payments = logfire.withTags('payments')

payments.info('Payment authorized {payment_id}', {
  payment_id: 'pay_123',
})

await payments.span('Capture payment {payment_id}', {
  attributes: { payment_id: 'pay_123' },
  callback: async () => capturePayment('pay_123'),
})
```

Scoped clients do not mutate global defaults. Per-call tags are appended after
scoped tags and duplicates are removed while preserving order. `withSettings()`
currently supports reusable `tags` and a default `level` for calls such as
`log()` and spans whose options do not set a level.

## Function instrumentation

Use `instrument()` to wrap a sync or async function in a Logfire span without
changing the function body:

```ts
import * as logfire from 'logfire'

const fetchCustomer = logfire.instrument(
  async (customerId: string) => {
    return loadCustomer(customerId)
  },
  {
    message: 'Fetch customer {customer_id}',
    extractArgs: ['customer_id'],
    tags: ['customers'],
  }
)

await fetchCustomer('cus_123')
```

Argument extraction is off by default. Prefer explicit names such as
`extractArgs: ['customer_id']`; `extractArgs: true` is best effort and can be
unreliable after bundling or minification. `recordReturn: true` records
successful return values as telemetry on a best-effort basis, but never makes a
successful function call fail because return serialization failed.

Scoped clients expose the same wrapper:

```ts
const customers = logfire.withTags('customers')

const syncCustomer = customers.instrument(syncCustomerImpl, {
  message: 'Sync customer {customer_id}',
  extractArgs: ['customer_id'],
})
```

TypeScript decorators are intentionally not part of this first pass.

## Minimum level filtering

Use `configureLogfireApi({ minLevel })` to suppress low-severity manual Logfire
telemetry before spans are created. This is separate from console-output
configuration:

```ts
import * as logfire from 'logfire'

logfire.configureLogfireApi({
  minLevel: 'warning',
})
```

`minLevel` accepts `trace`, `debug`, `info`, `notice`, `warning`, `error`, or
`fatal`, or numeric values from `logfire.Level`. Set `minLevel: null` to clear a
previous setting. Log helpers and `reportError()` are filtered by their level;
`span()`, `startSpan()`, `startPendingSpan()`, and `instrument()` are filtered
only when the call or scoped client sets an explicit level.

Filtered `span()` callbacks still run with a no-op span. Thrown or rejected
errors propagate normally, but Logfire does not record them because the call was
filtered. Use `reportError()` or a span level at or above the minimum when
errors should always be reported.

## Attribute serialization

Logfire serializes object and array attributes as JSON strings and adds
`logfire.json_schema` metadata so the backend can render them as structured
values. By default, schema metadata uses bounded best-effort inference for
ordinary JSON-like values such as objects, arrays, strings, numbers, booleans,
`null`, and dates.

Configure `jsonSchema` when you need a cheaper or quieter mode:

```ts
import * as logfire from 'logfire'

logfire.configureLogfireApi({
  jsonSchema: 'basic',
})
```

Use `jsonSchema: 'basic'` for legacy broad top-level `object`/`array` schemas,
or `jsonSchema: false` to omit `logfire.json_schema` entirely. This only
controls schema metadata; object and array attributes are still serialized as
JSON strings. Values that cannot be serialized are recorded as
`"[unserializable]"`.

## Error reporting

Use `reportError()` from explicit catch blocks. The caught value can be
`unknown`, matching modern TypeScript catch behavior:

```ts
try {
  await syncCustomer()
} catch (error) {
  logfire.reportError('Customer sync failed', error, { customer_id: 'cus_123' }, { tags: ['customers'] })
}
```

The third argument is always structured attributes. Use the optional fourth
argument for report options such as `tags` or `parentSpan`. The JavaScript API
does not include a Python-style `exception()` helper in this first pass.

## Baggage span attributes

Configure an explicit baggage allowlist when stable OpenTelemetry baggage values
should be copied onto Logfire manual spans and logs:

```ts
import { configureLogfireApi } from 'logfire'

configureLogfireApi({
  baggage: {
    spanAttributes: ['tenant', 'region'],
  },
})
```

The Node and browser runtime packages expose the same shape through
`logfire.configure()`. Projection is disabled by default and affects Logfire
manual spans/logs, including `span()`, `startSpan()`, `startPendingSpan()`, log
helpers, `reportError()`, and `instrument()`.

Configured keys are emitted with a `baggage.` prefix, such as
`baggage.tenant`. User-provided attributes win if they already set the same
attribute key. Missing baggage keys are ignored, baggage metadata is ignored,
and values are kept as strings truncated to 1000 characters.

Baggage propagates across service boundaries. Do not store secrets,
credentials, session cookies, raw emails, or other sensitive user data in
baggage.

Use OpenTelemetry propagation APIs directly when you need to move context
through queues or background-job metadata:

```ts
import { context, propagation } from '@opentelemetry/api'
import * as logfire from 'logfire'

const carrier: Record<string, string> = {}
propagation.inject(context.active(), carrier)

const extractedContext = propagation.extract(context.active(), carrier)
await context.with(extractedContext, async () => {
  await logfire.span('process job', {
    callback: async () => processJob(),
  })
})
```

The carrier is a serializable object such as headers or queue metadata.
OpenTelemetry `Context` is runtime-local and is not serializable. Logfire JS
does not add generic `getContext()` / `attachContext()` wrappers in this first
pass; use the OpenTelemetry APIs directly for those cases.

## Manual pending spans

Use `startPendingSpan()` when you want to show a long-running operation as
pending immediately, without enabling automatic pending spans for every span in
the runtime:

```ts
import { startPendingSpan } from 'logfire'

const span = startPendingSpan('Load dashboard', { route: '/dashboard' })
try {
  await loadDashboard()
} finally {
  span.end()
}
```

The helper returns the real span for you to end and emits one
`logfire.span_type = "pending_span"` placeholder at start time. Runtimes that
also install automatic pending-span processing, such as Node.js, suppress the
automatic placeholder for this one real span so the manual placeholder is not
duplicated. The suppression marker is internal to `logfire` and is shared by
the hardcoded OpenTelemetry context key.

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
