# Next.js 16 with Bun

Minimal Next.js 16 App Router example that runs with Bun and full-stack OpenTelemetry instrumentation.

The page includes browser tracing from `instrumentation-client.ts`, a client component that creates one manual button-click span before calling a server route handler at `/api/hello`, and a same-origin proxy that forwards browser spans to Logfire without exposing the write token.

## Local Development

```bash
bun install
bun run dev
```

Open <http://localhost:8080>.

## Build

```bash
bun run build
bun run start
```

## Server-Side Tracing

Server-side tracing is configured in `instrumentation.ts` using `@vercel/otel`.

To send traces to Logfire, create `.env.local` with:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://logfire-api.pydantic.dev
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://logfire-api.pydantic.dev/v1/traces
OTEL_EXPORTER_OTLP_HEADERS=Authorization=<your-logfire-write-token>
LOGFIRE_TOKEN=<your-logfire-write-token>
NEXT_PUBLIC_OTEL_SERVICE_NAME=nextjs-bun-browser
```

Use `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` for server-side tracing. Use `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and `LOGFIRE_TOKEN` for the browser trace proxy in `proxy.ts`; `LOGFIRE_TOKEN` is server-only and must not be exposed as a `NEXT_PUBLIC_` variable.

Set `OTEL_LOG_LEVEL=all` temporarily if you need OpenTelemetry diagnostic output while debugging exporter setup.

## Vercel

`vercel.json` sets `bunVersion` to `1.x`, which opts Vercel Functions into the Bun runtime. The committed `bun.lock` makes Vercel use Bun for dependency installation.

Set the same OTLP environment variables in the Vercel project settings before deploying.
