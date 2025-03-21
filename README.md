# Pydantic Logfire — Uncomplicated Observability — JavaScript SDK

From the team behind [Pydantic](https://pydantic.dev/), **Logfire** is an observability platform built on the same belief as our
open source library — that the most powerful tools can be easy to use.

What sets Logfire apart:

- **Simple and Powerful:** Logfire's dashboard is simple relative to the power it provides, ensuring your entire engineering team will actually use it.
- **SQL:** Query your data using standard SQL — all the control and (for many) nothing new to learn. Using SQL also means you can query your data with existing BI tools and database querying libraries.
- **OpenTelemetry:** Logfire is an opinionated wrapper around OpenTelemetry, allowing you to leverage existing tooling, infrastructure, and instrumentation for many common packages, and enabling support for virtually any language. We offer full support for all OpenTelemetry signals (traces, metrics and logs).

**Feel free to report issues and ask any questions about Logfire in this repository!**

This repo contains the JavaScript SDK for `logfire` and its documentation; the server application for recording and displaying data is closed source.


## Usage

Depending on your environment, you can integrate Logfire in several ways. Follow the specific instructions below:

### Basic Node.js script

Using logfire from your Node.js script is as simple as [getting a write token](https://logfire.pydantic.dev/docs/how-to-guides/create-write-tokens/), installing the package, calling configure, and using the provided API. Let's create an empty project:

```sh
mkdir test-logfire-js;
cd test-logfire-js; 
npm init -y es6 # makes the package.json with `type: module`
npm install logfire
```

Then, create the following `hello.js` script in the directory:


```js
import * as logfire from 'logfire'

logfire.configure({
  token: 'test-e2e-write-token',
  advanced: {
    baseUrl: 'http://localhost:8000'
  },
  serviceName: 'example-node-script',
  serviceVersion: '1.0.0',
})


logfire.info('Hello from Node.js', {
  'attribute-key': 'attribute-value'
}, {
  tags: ['example', 'example2']
})
```

Run the script above with `node hello.js`, and you should see the span being logged in the live view of your Logfire project.



### Cloudflare Workers

First, install the `@pydantic/logfire-cf-workers @pydantic/logfire-api` NPM packages:

```sh
npm install @pydantic/logfire-cf-workers @pydantic/logfire-api
```
Next, add `compatibility_flags = [ "nodejs_compat" ]` to your wrangler.toml or `"compatibility_flags": ["nodejs_compat"]` if you're using `wrangler.jsonc`.

Add your [Logfire write token](https://logfire.pydantic.dev/docs/how-to-guides/create-write-tokens/) to your `.dev.vars` file. Check the [Cloudflare documentation for further details on how to manage and deploy the secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

```sh
LOGFIRE_TOKEN=your-write-token
```

Next, add the necessary instrumentation around your handler. The `tracerConfig` function will extract your write token from the `env` object and provide the necessary configuration for the instrumentation:

```ts
import * as logfire from '@pydantic/logfire-api';
import { instrument } from '@pydantic/logfire-cf-workers';

const handler = {
	async fetch(): Promise<Response> {
		logfire.info('info span from inside the worker body');
		return new Response('Hello World!');
	},
} satisfies ExportedHandler;

export default instrument(handler, {
	serviceName: 'cloudflare-worker',
	serviceNamespace: '',
	serviceVersion: '1.0.0',
});
```

A working example can be found in the `examples/cloudflare-worker` directory. 

### Next.js / Vercel

Vercel provides a comprehensive OpenTelemetry integration through the `@vercel/otel` package. After following [their integration instructions](https://vercel.com/docs/otel), Add the following two env variables to your project:

```sh
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://logfire-api.pydantic.dev/v1/traces
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://logfire-api.pydantic.dev/v1/metrics
OTEL_EXPORTER_OTLP_HEADERS='Authorization=your-write-token'
```

The above will point the instrumentation to Logfire.

Optionally, you can use the Logfire API package for creating manual spans. Install the `@pydantic/logfire-api` NPM package and call the respective methods from your server-side code:

```tsx
import * as logfire from '@pydantic/logfire-api'

export default async function Home() {
  return logfire.startActiveSpan(logfire.Level.Warning, 'A warning span', {}, {}, async () => {
    logfire.info('Nested info span');
    return <div>Hello</div>;
  })
}
```

A working example can be found in the `examples/nextjs` directory.

### Express, generic Node instrumentation

For the purposes of the example, we will instrument this simple Express app:

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

Next, we will install the `logfire` and `dotenv` NPM packages, so that we can keep our Logfire write token in a `.env` file:

```sh
npm install logfire dotenv
```

Add your token to the `.env` file:


```sh
LOGFIRE_TOKEN=your-write-token
```

Afterwards, we will create an `instrumentation.ts` file that will set up the instrumentation. The `logfire` package includes a `configure` function that simplifies the setup:

```ts
// instrumentation.ts
import * as logfire from 'logfire'
import 'dotenv/config'

logfire.configure()
```

The `logfire.configure` call should happen before the actual express module imports, so your NPM start script should look something like this (`package.json`):

```json
"scripts": {
  "start": "npx ts-node --require ./instrumentation.ts app.ts"
},
```

#### Configuring the instrumentation

The `logfire.configure` function accepts a set of configuration options that control the behavior of the instrumentation. Alternatively, you can [use environment variables](https://logfire.pydantic.dev/docs/reference/configuration/#programmatically-via-configure) to configure the instrumentation.

## Trace API 

The `@pydantic/logfire-api` exports several convenience wrappers around the OpenTelemetry span creation API. The `logfire` package re-exports those. 

The following methods create spans with the respective log levels (ordered by severity):

* `logfire.trace`
* `logfire.debug`
* `logfire.info`
* `logfire.notice`
* `logfire.warn`
* `logfire.error`
* `logfire.fatal`

Each method accepts a message, attributes, and, optionally options that let you specify the span tags. The attributes values must be serializable to JSON.

```ts
function info(
  message: string, 
  attributes?: Record<string, unknown>, 
  options?: LogOptions
): void
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development instructions.

## License

MIT
