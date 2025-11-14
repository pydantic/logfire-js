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

## Contributing

See [CONTRIBUTING.md](https://github.com/pydantic/logfire-js/blob/main/CONTRIBUTING.md) for development instructions.

## License

MIT
