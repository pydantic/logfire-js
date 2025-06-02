# Example for a Next.js client/server distributed OTel instrumentation with Logfire


The example showcases how a fetch request initiated from the browser can propagate to the server and then to a third-party service, all while being instrumented with OpenTelemetry. The example uses the Logfire OTel SDK for both the client and server sides.

## Highlights

- The `ClientInstrumentationProvider` is a client-only component that instruments the browser fetch.
- To avoid exposing the write token, the middleware.ts proxies the logfire `/v1/traces` request.
- The instrumentation.ts file is the standard `@vercel/otel` setup. 
- The `.env` should look like this: 

```sh
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://logfire-api.pydantic.dev/v1/traces
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://logfire-api.pydantic.dev/v1/metrics
OTEL_EXPORTER_OTLP_HEADERS='Authorization=your-token'
LOGFIRE_TOKEN='your-token'
```

NOTE: alternatively, if you're not sure about the connection between the client and the server, you can host the proxy at a different location (e.g. Cloudflare).
