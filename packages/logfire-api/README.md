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
