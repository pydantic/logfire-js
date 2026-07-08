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

The Cloudflare package's `instrument(handler, config)` function configures the
Worker runtime. To wrap an individual function in a manual Logfire span, import
the core wrapper from `logfire`:

```ts
import { instrument as instrumentFunction } from 'logfire'
import { instrument as instrumentWorker } from '@pydantic/logfire-cf-workers'
```

Durable Object classes can be wrapped with `instrumentDO()` from this package so
they use the same Logfire token, base URL, environment, and scrubbing
configuration as Worker handlers.

```ts
import { instrumentDO } from '@pydantic/logfire-cf-workers'

class CounterDurableObject implements DurableObject {
  async fetch(): Promise<Response> {
    return new Response('ok')
  }
}

export const Counter = instrumentDO(CounterDurableObject, {
  service: {
    name: 'counter-do',
    namespace: '',
    version: '1.0.0',
  },
})
```

Request and response headers are not captured as span attributes by default. To
record specific headers, use the Cloudflare OpenTelemetry config fields exposed
through this package's existing `fetch` and `handlers` options:

```ts
export default instrumentWorker(handler, {
  service: {
    name: 'my-worker',
  },
  handlers: {
    fetch: {
      captureHeaders: {
        request: ['x-request-id'],
        response: ['cache-control'],
      },
    },
  },
})
```

Logfire scrubbing still helps redact sensitive attributes before export, but it
is a backstop. Prefer explicit header capture over capturing every header.

## Runtime lifecycle

Cloudflare Workers do not have a process-style shutdown hook. Logfire relies on
the Worker request lifetime instead: each instrumented handler schedules span
export with `ctx.waitUntil()` after the handler finishes.

This applies to both Logfire entrypoints:

- `instrumentInProcess()` and its `instrument()` alias configure in-process OTLP
  export.
- `instrumentTail()` configures tail Worker export.

Both entrypoints use this repository's Cloudflare Worker OpenTelemetry
instrumentation internally. The instrumentation proxies the Worker execution
context, tracks promises passed to `ctx.waitUntil()` inside the user handler,
then schedules span export on the original context with `ctx.waitUntil()`.
Export waits for a scheduler tick and the tracked promises before force-flushing
the configured span processors.

Because export is tied to each Worker event, there is no long-lived Logfire
runtime to shut down after deployment. Use `ctx.waitUntil()` for any asynchronous
work that should be included in request-lifetime telemetry.

## Managed Variables

Cloudflare Workers can use local managed variables from `logfire/vars` when the
worker already depends on the core `logfire` package. Remote managed variables
need a Logfire API key, so only configure them when the key is stored as a
Worker secret and never sent to a browser client.

## Contributing

See [CONTRIBUTING.md](https://github.com/pydantic/logfire-js/blob/main/CONTRIBUTING.md) for development instructions.

## License

MIT
