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

## Evaluations

`@pydantic/logfire-node/evals` provides offline + online evaluation primitives
that emit OTel spans / log events compatible with the Logfire Evaluations UI.
The wire format matches the Python `pydantic-evals` package, so dataset YAML /
JSON files round-trip across the two languages.

```ts
import * as logfire from '@pydantic/logfire-node'
import { Case, Dataset, Equals, EqualsExpected, withOnlineEvaluation } from '@pydantic/logfire-node/evals'

logfire.configure({ serviceName: 'sentiment-classifier' })

async function classify({ text }: { text: string }): Promise<string> {
  return text.toLowerCase().includes('love') ? 'POSITIVE' : 'NEUTRAL'
}

// Offline — runs your task against a labeled dataset and emits an experiment span.
const dataset = new Dataset<{ text: string }, string>({
  cases: [new Case({ inputs: { text: 'I love this!' }, expectedOutput: 'POSITIVE', name: 'a' })],
  evaluators: [new EqualsExpected()],
  name: 'sentiment-classifier',
})
const report = await dataset.evaluate(classify)

// Online — wraps a function so each call also dispatches evaluators in the background.
const monitored = withOnlineEvaluation(classify, {
  evaluators: [new Equals({ value: 'POSITIVE' })],
  target: 'sentiment-classifier',
})
await monitored({ text: 'I love this!' })
```

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

## Contributing

See [CONTRIBUTING.md](https://github.com/pydantic/logfire-js/blob/main/CONTRIBUTING.md) for development instructions.

## License

MIT
