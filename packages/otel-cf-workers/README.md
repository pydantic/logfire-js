# @pydantic/otel-cf-workers

Implementation-level OpenTelemetry instrumentation for Cloudflare Workers.

Logfire users should start with [`@pydantic/logfire-cf-workers`](https://www.npmjs.com/package/@pydantic/logfire-cf-workers).
Use this package directly when you want lower-level OpenTelemetry Worker instrumentation without the Logfire wrapper.

This package is ESM-only. Use `import` from ESM code; CommonJS `require()` is not supported.

Issues and contributions live in the [`pydantic/logfire-js`](https://github.com/pydantic/logfire-js) monorepo under
[`packages/otel-cf-workers`](https://github.com/pydantic/logfire-js/tree/main/packages/otel-cf-workers).

## Getting started

```bash
npm install @pydantic/otel-cf-workers @opentelemetry/api@^1.9.0
```

> [!IMPORTANT]
> To use the OpenTelemetry library in Cloudflare Workers you have to add the Node.js compatibility flag in your `wrangler.toml` or `wrangler.jsonc` file.

```
compatibility_flags = [ "nodejs_compat" ]
```

For the recommended Logfire Worker setup, see the
[`@pydantic/logfire-cf-workers` documentation](https://logfire.pydantic.dev/docs/packages/cloudflare/).

### Code example

```typescript
import { trace } from '@opentelemetry/api'
import { instrument } from '@pydantic/otel-cf-workers'
import type { ResolveConfigFn } from '@pydantic/otel-cf-workers'

export interface Env {
  HONEYCOMB_API_KEY: string
  OTEL_TEST: KVNamespace
}

const handler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    await fetch('https://cloudflare.com')

    const greeting = "G'day World"
    trace.getActiveSpan()?.setAttribute('greeting', greeting)
    ctx.waitUntil(fetch('https://workers.dev'))
    return new Response(`${greeting}!`)
  },
}

const config: ResolveConfigFn = (env: Env, _trigger) => {
  return {
    exporter: {
      url: 'https://api.honeycomb.io/v1/traces',
      headers: { 'x-honeycomb-team': env.HONEYCOMB_API_KEY },
    },
    service: { name: 'greetings' },
  }
}

export default instrument(handler, config)
```

## Auto-instrumentation

### Workers

Wrapping your exporter handler with the `instrument` function is all you need to do to automatically have not just the functions of you handler auto-instrumented, but also the global `fetch` and `caches` and all of the supported bindings in your environment such as KV.

See the quick start code sample for an example of how it works.

### Durable Objects

Instrumenting Durable Objects work very similar to the regular Worker auto-instrumentation. Instead of wrapping the handler in an `instrument` call, you wrap the Durable Object class with the `instrumentDO` function.

```typescript
import { instrumentDO } from '@pydantic/otel-cf-workers'
import type { ResolveConfigFn } from '@pydantic/otel-cf-workers'

const config: ResolveConfigFn = (env: Env, _trigger) => {
  return {
    exporter: {
      url: 'https://api.honeycomb.io/v1/traces',
      headers: { 'x-honeycomb-team': env.HONEYCOMB_API_KEY },
    },
    service: { name: 'greetings-do' },
  }
}

class OtelDO implements DurableObject {
  async fetch(request: Request): Promise<Response> {
    return new Response('Hello World!')
  }
}

const TestOtelDO = instrumentDO(OtelDO, config)

export { TestOtelDO }
```

## Creating custom spans

While auto-instrumenting should take care of a lot of the information that you would want to add, there will always be application specific information you want to send along.

You can get the current active span by doing:

```typescript
import { trace } from '@opentelemetry/api'

const handler = {
  async fetch(request: Request) {
    const span = trace.getActiveSpan()
    span?.setAttribute('name', 'value')
    return new Response('ok')
  },
}
```

Or if you want to create a new span:

```typescript
import { trace } from '@opentelemetry/api'

const handler = {
  async fetch(request: Request) {
    const tracer = trace.getTracer('my_own_tracer_name')
    return tracer.startActiveSpan('name', async (span) => {
      const response = await doSomethingAwesome()
      span.end()
      return response
    })
  },
}
```

## Configuration

For configuration you can either pass in a
[`TraceConfig`](https://github.com/pydantic/logfire-js/blob/main/packages/otel-cf-workers/src/types.ts) or a function that takes the Environment and the trigger for this particular trace and returns a `TraceConfig`.

Because the configuration function is run separately for every new invocation, it is possible to tailor your configuration for every type of request. So it is for example possible to have a much lower sampling ratio for your healthchecks than actual API requests.

### Exporter

In the `exporter`, you need to configure where to send spans to. It can take either an instance of a class that implements the standard OpenTelemetry `SpanExporter` interface, or an object with the properties `url` and optionally `headers` to configure an exporter for the OpenTelemetry format.

Examples:

```typescript
const exporter = new ConsoleSpanExporter()
```

```typescript
const exporter = {
  url: 'https://api.honeycomb.io/v1/traces',
  headers: { 'x-honeycomb-team': env.HONEYCOMB_API_KEY },
}
```

### Fetch

`includeTraceContext` is used to specify if outgoing requests should include the TraceContext so that the other service can participate in a distributed trace.
The default is `true` for all outgoing requests, but you can turn it off for all requests with `false`, or specify a method that takes the outgoing `Request` method and return a boolean on whether to include the tracing context.

Example:

```typescript
const fetchConf = (request: Request): boolean => {
  return new URL(request.url).hostname === 'example.com'
}
```

Request and response headers are not captured as span attributes by default.
Capture the headers you need with `captureHeaders.request` and
`captureHeaders.response`. Header names are matched case-insensitively, and
captured values are recorded as arrays on `http.request.header.<name>` and
`http.response.header.<name>`.

```typescript
const fetch = {
  captureHeaders: {
    request: ['x-request-id'],
    response: ['cache-control'],
  },
}
```

You can use a predicate for dynamic selection:

```typescript
const fetch = {
  captureHeaders: {
    request: (name: string) => name.startsWith('x-'),
  },
}
```

Set a selector to `true` only when you intentionally want to capture every
header. This can record sensitive values such as cookies and authorization
tokens.

```typescript
const fetch = {
  captureHeaders: {
    request: true,
    response: true,
  },
}
```

### Handlers

The `handlers` field of the configuration overrides the way in which event handlers, such as `fetch` or `queue`, are instrumented.

#### Fetch Handler

`acceptTraceContext` is used to specify if incoming requests handled by `fetch` should accept a TraceContext and participate in a distributed trace.
The default is `true` for all incoming requests, but you can turn it off for all requests with `false` or specify a method that takes the incoming `Request` and returns a boolean indicating whether to accept the tracing context.

Example:

```typescript
const fetchConf = (request: Request): boolean => {
  return new URL(request.url).hostname === 'example.com'
}
```

Incoming Worker fetch spans use the same explicit header capture shape under
`handlers.fetch.captureHeaders`:

```typescript
const handlers = {
  fetch: {
    captureHeaders: {
      request: ['x-request-id'],
      response: ['cache-control'],
    },
  },
}
```

### PostProcessor

The PostProcessor function is called just before exporting the spans and allows you to make any changes to the spans before sending this. For example to remove entire spans, or to remove or redact security or privacy sensitive data.

Example:

```typescript
const postProcessor = (spans: ReadableSpan[]): ReadableSpan[] => {
  spans[0].attributes['http.url'] = 'REDACTED'
  return spans
}
```

### Sampling

One of the challenges of tracing is that for sites and applications with a lot of traffic it becomes prohibitively expensive to store every trace. So the question becomes how to store the ones with the most interesting information and drop the ones that are the least interesting. That is where sampling comes in.

#### Head Sampling vs Tail Sampling

There are two (complimentary) sampling strategies: Head Sampling and Tail Sampling and in a lot of cases you will want to use a combination to get the most information into the least amount of sampled events.

To understand the difference in head vs tail sampling in our context, we have to understand distributed tracing. A distributed trace is one that spans multiple systems or services. At every point another service is called, we inject a header with the information about the trace, such as the traceId, the parentSpanId and a hint if this trace is sampled.

Head Sampling, as the name implies, is done at the beginning of a span/trace. In our case it is mostly used to signal to downstream systems whether or not to sample a particular trace, because we can always drop the current services portion of a trace during Tail Sampling.

Head Sampling can be configured with any standard OpenTelemetry `Sampler` or an object with a `ratio` property and optional `acceptRemote` property. The default is the AlwaysOnSampler, which samples every single request.

Examples:

```typescript
const headSampler = new AlwaysOnSampler()
```

```typescript
const headSampler = {
	acceptRemote: false //Whether to accept incoming trace contexts
	ratio: 0.5 //number between 0 and 1 that represents the ratio of requests to sample. 0 is none and 1 is all requests.
}
```

Tail Sampling on the other hand is done at the end. Because we record every single span, even if it isn't head sampled, it is possible to still sample the local part of a trace in say the event of an error.

Example:

```typescript
const tailSampler = (traceInfo: LocalTrace): boolean => {
  const localRootSpan = traceInfo.localRootSpan as unknown as ReadableSpan
  return (localRootSpan.spanContext().traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED
}
```

The default is a tailSampler that samples traces that have been head sampled or if the local root span is marked as an error.

## OpenTelemetry Compatibility

This package supports `@opentelemetry/api` `^1.9.1` as a peer dependency and is built against the current OpenTelemetry JS 2.x / experimental 0.x SDK packages used by the `pydantic/logfire-js` workspace catalog.

Unstable semantic convention keys are owned internally so consumers do not need to import `@opentelemetry/semantic-conventions/incubating`.

#### Service

Service identifies the service and version to help with querying.

Example:

```typescript
const service = {
	name: 'some_name' //required. The name of your service
	version: '1.0.4' //optional: An opaque version string. Can be a semver or git hash for example
	namespace: 'namespace' //optional: Useful to group multiple services together in one namespace.
}
```

### Propagation

Register a custom propagator with:

```ts
const config: ResolveConfigFn = (env: Env, _trigger) => {
  return {
    propagator: new MyCoolPropagator(),
  }
}
```

## Distributed Tracing

One of the advantages of using OpenTelemetry is that it makes it easier to do distributed tracing through multiple different services. This library will automatically inject the W3C Trace Context headers when making calls to Durable Objects or outbound fetch calls.

## Limitations

- The worker runtime does not expose accurate timing information to protect against side-channel attacks such as Spectre and will only update the clock on IO, so any CPU heavy processing will look like it takes 0 milliseconds.
- Not everything is auto-instrumented yet. See the lists below for what is and isn't.

Triggers:

- [x] Email (`handler.email`)
- [x] HTTP (`handler.fetch`)
- [x] Queue (`handler.queue`)
- [x] Cron (`handler.scheduled`)
- [ ] Tail (`handler.tail`)
- [x] Durable Objects fetch
- [x] Durable Objects alarm
- [ ] Durable Objects hibernated WebSocket
- [x] waitUntil (`ctx.waitUntil`)

Globals/built-ins:

- [x] Fetch
- [x] Caches
- [x] Durable Object Storage

Cloudflare modules

- [ ] `cloudflare:email`
- [ ] `cloudflare:sockets`

Bindings:

- [x] KV
- [x] Queue
- [x] Durable Objects
- [ ] R2
- [x] D1
- [x] Service Bindings
- [x] Analytics Engine
- [ ] Browser Rendering
- [ ] Workers AI
- [ ] Email Sending
- [ ] mTLS
- [ ] Vectorize
- [ ] Hyperdrive
- [ ] Workers for Platforms Dispatch
