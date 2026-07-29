---
title: Getting started
description: Install the Logfire TypeScript SDK, send your first span from Node.js, and get automatic traces from the frameworks you already use.
---

# Getting started

Go from install to your first trace in about five minutes. A **trace** is the full record of one request, job, or task from start to finish, made of nested **spans**; a span is one operation within it, with a name, a start, and a duration. The Logfire TypeScript SDK is built on [OpenTelemetry](https://opentelemetry.io/), the open industry standard, and works across Node.js, browsers, Cloudflare Workers, and other OpenTelemetry-compatible runtimes.

## Before you start

You need a Logfire project to send data to, and a recent Node.js:

1. [Create a free account](https://logfire.pydantic.dev/login) and create a project when prompted. A project is a namespace that holds your data.
2. Install Node.js 24 or newer, with a package manager such as npm or pnpm.

> Your telemetry is stored in the Logfire [data region](https://pydantic.dev/docs/logfire/manage/data-regions/) you choose when you create your account.

## Let an AI agent set it up

To have an AI coding agent wire this up for you, paste this into Claude Code, Cursor, or a similar tool:

```text
Set up Pydantic Logfire in this TypeScript project. Read
https://pydantic.dev/docs/logfire/typescript-sdk/get-started/ and follow it: install
@pydantic/logfire-node, call logfire.configure() in an instrumentation.ts file loaded before
the app with `tsx --import`, and set the LOGFIRE_TOKEN environment variable from the project's
Settings > Write tokens. Then run the app and confirm a trace reaches the Logfire Live view.
```

## Install and connect

Install the Node.js package into your app:

```bash
npm install @pydantic/logfire-node
```

Connect it to Logfire. For local development, sign in with the CLI:

```bash
npx logfire auth
npx logfire projects use my-project
```

The CLI writes `.logfire/logfire_credentials.json`, which the SDK reads automatically. For a deployed app or CI, set a **write token** instead (the credential your app uses to send data): copy one from your project's **Settings > Write tokens** and set it in the environment.

```bash
export LOGFIRE_TOKEN="your-write-token"
```

## Send your first span

Create `hello.ts`:

```ts title="hello.ts"
import * as logfire from '@pydantic/logfire-node'

logfire.configure({ serviceName: 'hello-logfire' })

await logfire.span('greeting', {
  callback: async () => {
    logfire.info('Hello world!')
  },
})

await logfire.shutdown()
```

`configure()` connects your app to Logfire. `span()` records one operation, and the `info()` inside it is a log (a timestamped record of a single event) nested in that span, so together they make your first trace. `shutdown()` flushes anything still buffered before a short-lived script exits.

Run it with [`tsx`](https://tsx.is/), which executes TypeScript directly:

```bash
npx tsx hello.ts
```

> These examples are ES modules. `tsx` runs them in any project. To run them with `node` directly (Node.js 24 strips the types), your project needs to be an ES module: add `"type": "module"` to your `package.json`.

## See it in the Live view

Open the [Live view](https://pydantic.dev/docs/logfire/observe/live/) for your project. Your `greeting` trace appears as it arrives: one row for the span, with the `Hello world!` log nested inside it. Click the span to open its full trace and read its details.

## Get automatic traces

The `greeting` span is a manual example. Most of your traces should come **automatically**: the SDK records every incoming request, database query, and outgoing call as a span, without you writing any by hand.

Install the OpenTelemetry auto-instrumentations, and move `configure()` into its own file so it loads before the rest of your app:

```bash
npm install @opentelemetry/auto-instrumentations-node
```

```ts title="instrumentation.ts"
import * as logfire from '@pydantic/logfire-node'

logfire.configure({
  serviceName: 'my-app',
  serviceVersion: '1.0.0',
  environment: 'production',
})
```

`serviceVersion` and `environment` tag every span, so you can filter and compare releases and environments in Logfire. Start your app with the instrumentation loaded first:

```bash
npx tsx --import ./instrumentation.ts server.ts
```

Now requests through Express and Fastify, queries to PostgreSQL, MySQL, and Redis, and outgoing HTTP all arrive as traces. Send a request to your app and it appears in the Live view, with the queries and outgoing calls it triggered nested inside. The `auto-instrumentations-node` meta-package turns them all on at once; a few (such as the filesystem instrumentation) are noisy, so see the [Node.js package](packages/node.md) to enable or disable individual ones.

> Automatic instrumentation wraps each library as Node loads it, which is why the instrumentation file has to load first. A bundler (esbuild, webpack, or a framework like Next.js) inlines those libraries into your build, so Node never loads them on their own and the spans go missing. For a bundled server, follow your framework's guide, such as [Next.js](frameworks/nextjs.md).

## Troubleshooting

| Symptom                                   | Likely cause                                    | Fix                                                                                                                                     |
| ----------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Nothing appears in the Live view          | No credentials set                              | Run `npx logfire auth`, or set `LOGFIRE_TOKEN` from **Settings > Write tokens**                                                         |
| A short script sends nothing              | The process exited before telemetry was flushed | Call `await logfire.shutdown()` before exiting                                                                                          |
| Automatic traces are missing              | The app loaded before instrumentation did       | Load the instrumentation file first, for example `npx tsx --import ./instrumentation.ts server.ts`, and keep `configure()` in that file |
| A `.ts` file won't run, or `import` fails | No TypeScript runner, or a CommonJS project     | Run with `npx tsx`, which handles TypeScript and ES modules in any project                                                              |

## Next steps

- **New to tracing?** [Core concepts](https://pydantic.dev/docs/logfire/get-started/concepts/) explains spans, traces, and logs, and how to read them.
- **Pick your runtime:** [Node.js](packages/node.md), [Browser](packages/browser.md), [Cloudflare Workers](packages/cloudflare.md), or the runtime-agnostic [`logfire`](packages/logfire.md) manual API.
- **Instrument a framework:** [Express](frameworks/express.md), [Next.js](frameworks/nextjs.md), [Deno](frameworks/deno.md), or the [Vercel AI SDK](frameworks/vercel-ai.md).
