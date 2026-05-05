---
title: Evaluations
description: Use logfire/evals for offline datasets, online evaluation, built-in evaluators, and Python-compatible dataset files.
---

# Evaluations

`logfire/evals` provides JavaScript evaluation primitives that emit Logfire-compatible telemetry. The dataset YAML and JSON formats are compatible with Python `pydantic-evals`.

## Install

Add `logfire` as a direct dependency when importing the evals subpath:

```bash
npm install logfire
```

In Node.js applications, also configure `@pydantic/logfire-node` so evaluation spans are exported:

```ts
import * as logfire from '@pydantic/logfire-node'

logfire.configure({
  serviceName: 'sentiment-evals',
})
```

## Offline Evaluation

```ts
import { Case, Dataset, EqualsExpected } from 'logfire/evals'

const dataset = new Dataset<{ text: string }, string>({
  cases: [
    new Case({
      expectedOutput: 'POSITIVE',
      inputs: { text: 'I love this' },
      name: 'positive example',
    }),
  ],
  evaluators: [new EqualsExpected()],
  name: 'sentiment-classifier',
})

const report = await dataset.evaluate(({ text }) => {
  return text.toLowerCase().includes('love') ? 'POSITIVE' : 'NEUTRAL'
})
```

## Online Evaluation

```ts
import { Equals, withOnlineEvaluation } from 'logfire/evals'

async function classify({ text }: { text: string }) {
  return text.toLowerCase().includes('love') ? 'POSITIVE' : 'NEUTRAL'
}

const monitored = withOnlineEvaluation(classify, {
  evaluators: [new Equals({ value: 'POSITIVE' })],
  target: 'sentiment-classifier',
})

await monitored({ text: 'I love this' })
```

## Runtime Notes

`Dataset.toFile()` and `Dataset.fromFile()` work in Node.js, Bun, and Deno. Browser and Cloudflare Worker runtimes can use in-memory datasets and online evaluation, but not filesystem-backed dataset helpers.

Browser offline evaluations should use low concurrency because browsers do not have Node.js `AsyncLocalStorage`.

See `examples/node/demo_evals.ts` and `examples/node/demo_online_evals.ts` for larger examples.
