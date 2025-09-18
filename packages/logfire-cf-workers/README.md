# Pydantic Logfire — JavaScript SDK

From the team behind [Pydantic Validation](https://pydantic.dev/), **Pydantic Logfire** is an observability platform built on the same belief as our open source library — that the most powerful tools can be easy to use.

What sets Logfire apart:

- **Simple and Powerful:** Logfire's dashboard is simple relative to the power it provides, ensuring your entire engineering team will actually use it.
- **SQL:** Query your data using standard SQL — all the control and (for many) nothing new to learn. Using SQL also means you can query your data with existing BI tools and database querying libraries.
- **OpenTelemetry:** Logfire is an opinionated wrapper around OpenTelemetry, allowing you to leverage existing tooling, infrastructure, and instrumentation for many common packages, and enabling support for virtually any language.

See the [documentation](https://logfire.pydantic.dev/docs/) for more information.

**Feel free to report issues and ask any questions about Logfire in this repository!**

This repo contains the JavaScript Cloudflare SDK; the server application for recording and displaying data is closed source.

If you need to instrument your Node.js application, see the [`logfire` package](https://www.npmjs.com/package/logfire).
If you need to instrument your browser application, see the [Logfire Browser package](https://www.npmjs.com/package/@pydantic/logfire-browser).

## Basic usage

See the [cf-worker example](https://github.com/pydantic/logfire-js/tree/main/examples/cf-worker) for a primer.

## Contributing

See [CONTRIBUTING.md](https://github.com/pydantic/logfire-js/blob/main/CONTRIBUTING.md) for development instructions.

## License

MIT
