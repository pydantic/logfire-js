# Pydantic Logfire — JavaScript SDK

From the team behind [Pydantic Validation](https://pydantic.dev/), **Pydantic Logfire** is an observability platform built on the same belief as our open source library — that the most powerful tools can be easy to use.

What sets Logfire apart:

- **Simple and Powerful:** Logfire's dashboard is simple relative to the power it provides, ensuring your entire engineering team will actually use it.
- **SQL:** Query your data using standard SQL — all the control and (for many) nothing new to learn. Using SQL also means you can query your data with existing BI tools and database querying libraries.
- **OpenTelemetry:** Logfire is an opinionated wrapper around OpenTelemetry, allowing you to leverage existing tooling, infrastructure, and instrumentation for many common packages, and enabling support for virtually any language.

See the [documentation](https://logfire.pydantic.dev/docs/) for more information.

**Feel free to report issues and ask any questions about Logfire in this repository!**

This repo contains the JavaScript Browser SDK; the server application for recording and displaying data is closed source.

If you need to instrument your Node.js application, see the [`logfire` package](https://www.npmjs.com/package/logfire).
If you're instrumenting Cloudflare, see the [Logfire CF workers package](https://www.npmjs.com/package/@pydantic/logfire-cf-workers).

## Basic usage

See the [Logfire Browser docs for a primer](https://logfire.pydantic.dev/docs/integrations/javascript/browser/). Ready to run examples are available in the repository [in vanilla browser](https://github.com/pydantic/logfire-js/tree/main/examples/browser) and [Next.js variants](https://github.com/pydantic/logfire-js/tree/main/examples/nextjs-client-side-instrumentation).

## Managed Variables

Browser applications can use local managed variables from `logfire/vars` when
the app already depends on the core `logfire` package. Do not configure the
remote provider in browser bundles because it requires a Logfire API key.

## Resource attributes

Use `resourceAttributes` for stable browser application or session metadata that
should be attached to all telemetry from the configured provider:

```js
import * as logfire from '@pydantic/logfire-browser'

logfire.configure({
  traceUrl: '/client-traces',
  serviceName: 'browser-app',
  resourceAttributes: {
    'service.namespace': 'my-company',
    'app.installation.id': installationId,
  },
})
```

Do not use resource attributes for per-request values or sensitive user data.
First-class options such as `serviceName`, `serviceVersion`, and `environment`
take precedence over conflicting `resourceAttributes` keys.

## Baggage span attributes

Use `baggage.spanAttributes` to copy selected active OpenTelemetry baggage
values onto Logfire manual spans and logs:

```js
import * as logfire from '@pydantic/logfire-browser'

logfire.configure({
  traceUrl: '/client-traces',
  serviceName: 'browser-app',
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

## Runtime lifecycle

`configure()` returns an async cleanup function. Call it when your application is
tearing down the configured browser provider, such as in tests, previews, or
single-page app shells that replace the whole telemetry setup. Cleanup is
idempotent: repeated or concurrent calls share one promise and run the lifecycle
once in this order:

1. unregister configured instrumentations
2. force-flush spans
3. shut down the tracer provider

If any cleanup step fails, Logfire still attempts the later steps before
returning the first failure. Later calls return the same settled cleanup promise
rather than starting another cleanup cycle.

Browser pages also get OpenTelemetry's built-in batch-processor auto-flush on
document hide. The underlying batch span processor calls `forceFlush()` when the
document becomes hidden or emits `pagehide`, which helps export spans during
navigation away from the page. You can disable that OpenTelemetry behavior with
`batchSpanProcessorConfig.disableAutoFlushOnDocumentHide`, but doing so means
only explicit cleanup or normal batch timing will flush spans.

## Pending spans

Browser `configure()` does not install automatic pending-span processing.
Browser apps often produce many short-lived fetch and interaction spans, so
automatic pending spans can significantly increase span volume, network
pressure, and ingestion cost in a user-facing environment.

For long-running browser operations where an immediate placeholder is useful,
call `startPendingSpan()` explicitly:

```js
import * as logfire from '@pydantic/logfire-browser'

const span = logfire.startPendingSpan('Load dashboard', { route: '/dashboard' })
try {
  await loadDashboard()
} finally {
  span.end()
}
```

Manual pending spans still add one placeholder span for each call. Node.js
applications get automatic pending spans from `@pydantic/logfire-node`; Browser
keeps this behavior explicit.

## Contributing

See [CONTRIBUTING.md](https://github.com/pydantic/logfire-js/blob/main/CONTRIBUTING.md) for development instructions.

## License

MIT
