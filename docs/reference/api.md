---
title: API Overview
description: Overview of the main TypeScript SDK exports and package entry points.
---

# API Overview

This page is a package-level map of the public TypeScript SDK APIs. It is not a generated API reference.

## `logfire`

Manual tracing and logging:

- `span(message, options)` and `span(message, attributes, options, callback)`
- `startSpan(message, attributes?, options?)`
- `log()`, `trace()`, `debug()`, `info()`, `notice()`, `warning()`, `error()`, `fatal()`
- `reportError(message, error, extraAttributes?)`
- `Level`

Configuration helpers and utilities:

- `configureLogfireApi()`
- `logfireApiConfig`
- `resolveBaseUrl()`
- `resolveSendToLogfire()`
- `serializeAttributes()`
- `LogfireAttributeScrubber`
- `NoopAttributeScrubber`
- `TailSamplingProcessor`
- `ULIDGenerator`
- sampling helpers such as `levelOrDuration()`

Subpaths:

- `logfire/evals`
- `logfire/vars`

## `@pydantic/logfire-node`

Node.js runtime setup:

- `configure(options?)`
- `logfireConfig`
- `forceFlush()`
- `shutdown()`
- `DiagLogLevel`

The package also re-exports the public API from `logfire`.

## `@pydantic/logfire-browser`

Browser runtime setup:

- `configure(options)` returns an async shutdown function
- `DiagLogLevel`

The package also re-exports the public API from `logfire`.

## `@pydantic/logfire-cf-workers`

Cloudflare Worker setup:

- `instrument(handler, config)`
- `instrumentInProcess(handler, config)`
- `instrumentTail(handler, config)`
- `getTailConfig(config)`
- `exportTailEventsToLogfire(events, env)`

Unlike the Node and browser packages, this package does not re-export the manual `logfire` API as named exports. Import spans, logs, and `reportError` from `logfire` directly:

```ts
import * as logfire from 'logfire'
import { instrument } from '@pydantic/logfire-cf-workers'
```
