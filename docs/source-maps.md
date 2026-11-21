---
title: Source Maps
description: How the Logfire TypeScript SDK identifies the build behind an exception so stack traces resolve to original source.
---

# Source Maps

Browser bundles, Node.js bundles, and Cloudflare Workers usually run minified or transpiled code. To show an exception with its original file, function, and line, Logfire must know which build produced each stack frame. The SDK records that build identity on every exception it reports.

## Set a real service version

Source map resolution needs a `serviceVersion` that changes with every build, such as the commit SHA or the release tag. Several versions of a frontend are live at the same time while browsers keep old tabs open, so a fixed value cannot tell builds apart.

```ts
logfire.configureFrontend({
  baseUrl: 'https://logfire-us.pydantic.dev',
  serviceVersion: import.meta.env.VITE_COMMIT_SHA,
  token: '<frontend-application-token>',
})
```

When you do not set `serviceVersion`, the SDK uses the release identifier that the source map inject step stamped into the loaded bundle. In Node.js, `LOGFIRE_SERVICE_VERSION` and `OTEL_SERVICE_VERSION` take precedence over the injected release. The SDK reads the release when `configure()` runs, so in Node.js the bundle that carries it must load before that call; otherwise set `serviceVersion`.

The browser SDK still falls back to `0.0.1` when no version is available. That fallback is deprecated and is removed in the next major version.

## Debug IDs on exception spans

A source map inject step gives each built JavaScript file a debug ID, writes the same ID into its source map, and adds a short snippet to the top of the file. When the file loads, the snippet registers its debug ID in `globalThis._logfireDebugIds`, keyed by the stack trace it captures, so the SDK can tell which file registered it. This works in classic scripts, module scripts, Node.js, and Workers.

When an exception is recorded, the SDK finds the files in its stack trace that registered a debug ID and adds them to the span and to its `exception` event as the `logfire.debug_ids` attribute: a JSON string that maps each file URL to its debug ID.

```json
{
  "https://app.example.com/assets/index-a1b2.js": "2a4c6e8f-1b3d-4f5a-8c7e-9d0b1a2c3e4f",
  "https://app.example.com/assets/vendor-c3d4.js": "5b1c2a7e-8f4d-4e3b-9a61-0c2d3e4f5a6b"
}
```

- URLs have their query string, fragment, and credentials removed, the same way the browser SDK removes them from stack traces.
- Files without a debug ID add nothing. If no file in the stack has one, the attribute is absent and the span is unchanged.
- The SDK also reads `globalThis._debugIds`, the registry that other build tools such as Turbopack write. When both name the same file, `_logfireDebugIds` wins.
- The attribute is added to exceptions recorded through `reportError()`, failing `span()` and `instrument()` callbacks, global error and unhandled rejection handlers, and instrumentations that call `span.recordException()`.

Node.js and Workers frames are resolved only through debug IDs. Browser frames can also resolve by `serviceVersion` and the file path.

In Cloudflare Workers, each isolate has its own `globalThis`. The SDK adds debug IDs in the Worker that recorded the exception, before spans reach a tail Worker.

## Node.js source maps without upload

If your Node.js service ships its `.map` files next to the built code, Node.js can resolve stack traces itself. Enable it with `enableSourceMaps`:

```ts
import * as logfire from '@pydantic/logfire-node'

logfire.configure({
  enableSourceMaps: true,
  serviceVersion: process.env.COMMIT_SHA,
})
```

This calls `process.setSourceMapsEnabled(true)`. Recorded stack traces then name your original files and lines, and Logfire needs no uploaded maps.

- Call `configure()` before your application modules load, for example from a file passed to `node --import`. Node.js reads source maps only for files loaded after they are enabled.
- Do not install `source-map-support` alongside. It replaces `Error.prepareStackTrace`, which turns Node.js' own source map handling off.
- Frames that Node.js rewrites point at your original files, so debug IDs do not apply to them. Use either this option or uploaded source maps for a service.
- `enableSourceMaps: false` leaves Node.js as it started. It does not undo `--enable-source-maps`.
