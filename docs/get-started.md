---
title: Getting Started
description: Install the Logfire TypeScript SDK, configure a write token, and send your first span from Node.js.
---

# Getting Started

The fastest way to try the TypeScript SDK is a small Node.js script. You need a Logfire write token, Node.js 24 or newer, and a package manager such as npm or pnpm.

## Install

Create a project and install the Node package:

```bash
npm init -y
npm install @pydantic/logfire-node
```

Set your Logfire write token in the environment:

```bash
export LOGFIRE_TOKEN="your-write-token"
```

## Send a Span

Create `hello.mjs`:

```js
import * as logfire from '@pydantic/logfire-node'

logfire.configure({
  serviceName: 'hello-logfire-js',
  serviceVersion: '1.0.0',
})

await logfire.span('calculate checkout total', {
  attributes: { cart_id: 'cart_123', item_count: 3 },
  callback: async () => {
    logfire.info('checkout total calculated', { total: 42.5 })
  },
})

await logfire.forceFlush()
await logfire.shutdown()
```

Run it:

```bash
node hello.mjs
```

The span and nested log event will appear in your Logfire project.

## Runtime Packages

Use the package that owns SDK setup for your runtime:

- Node.js scripts and servers: [`@pydantic/logfire-node`](packages/node.md)
- Browser clients: [`@pydantic/logfire-browser`](packages/browser.md)
- Cloudflare Workers: [`@pydantic/logfire-cf-workers`](packages/cloudflare.md)
- Runtime-agnostic manual API only: [`logfire`](packages/logfire.md)

`@pydantic/logfire-node` and `@pydantic/logfire-browser` re-export the `logfire` manual API, so a single import suffices in those runtimes. With `@pydantic/logfire-cf-workers`, import spans and logs from `logfire` alongside `instrument` from the Workers package.
