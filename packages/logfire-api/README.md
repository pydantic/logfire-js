# Pydantic Logfire — Uncomplicated Observability — JavaScript SDK

From the team behind [Pydantic Validation](https://pydantic.dev/), **Pydantic Logfire** is an observability platform built on the same belief as our open source library — that the most powerful tools can be easy to use.

Check the [Github Repository README](https://github.com/pydantic/logfire-js) for more information on how to use the SDK.

## Evaluations

`logfire/evals` exports the JavaScript evaluation API: offline `Dataset`
experiments, built-in case evaluators, report-level analyses, and
`withOnlineEvaluation` for live monitoring. The emitted span/log wire format and
dataset YAML/JSON format match Python `pydantic-evals`.

```ts
import { Case, Dataset, EqualsExpected } from 'logfire/evals'

const dataset = new Dataset<{ text: string }, string>({
  cases: [new Case({ expectedOutput: 'HELLO', inputs: { text: 'hello' }, name: 'hello' })],
  evaluators: [new EqualsExpected()],
  name: 'uppercase',
})

const report = await dataset.evaluate(({ text }) => text.toUpperCase())
```

`Dataset.toFile` / `Dataset.fromFile` are available in Node, Bun, and Deno.
Browser and Cloudflare Worker runtimes can use in-memory datasets and online
evaluation, but not filesystem-backed dataset helpers.

Serialized datasets use Python-compatible snake_case evaluator options and
span queries. For online evaluation, JavaScript parameter-name extraction is
best effort; use `extractArgs: ['argName']` when evaluator code needs stable
`context.inputs` keys in bundled or minified builds, or `extractArgs: false`
to keep positional input values.

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
