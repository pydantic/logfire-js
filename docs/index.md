---
title: TypeScript SDK
description: TypeScript and JavaScript SDK documentation for Pydantic Logfire.
---

# TypeScript SDK

The TypeScript SDK provides Logfire support for JavaScript and TypeScript applications across Node.js, browsers, Cloudflare Workers, and other OpenTelemetry-compatible runtimes.

These docs cover the JavaScript packages that live in the `pydantic/logfire-js` repository. The main Logfire documentation remains focused on the Python SDK and the Logfire platform; this chapter is the package and runtime guide for JavaScript applications.

## Packages

- [`logfire`](packages/logfire.md) provides the runtime-agnostic manual tracing API: spans, logs, levels, error reporting, sampling helpers, evaluations, and managed variables.
- [`@pydantic/logfire-node`](packages/node.md) configures the OpenTelemetry Node SDK, exporters, automatic instrumentation, logs, metrics, and the `logfire` manual API.
- [`@pydantic/logfire-browser`](packages/browser.md) configures browser tracing and re-exports the `logfire` manual API for client code.
- [`@pydantic/logfire-cf-workers`](packages/cloudflare.md) instruments Cloudflare Workers and forwards Worker spans to Logfire.

## Where to Start

Use [Getting Started](get-started.md) for a minimal script, then move to the package page for your runtime:

- Server-side Node.js applications should start with [Node.js](packages/node.md).
- Browser applications should start with [Browser](packages/browser.md), especially the proxy requirement.
- Cloudflare Workers should start with [Cloudflare Workers](packages/cloudflare.md).
- Framework users can use the [Express](frameworks/express.md), [Next.js](frameworks/nextjs.md), [Deno](frameworks/deno.md), or [Vercel AI SDK](frameworks/vercel-ai.md) guides.
