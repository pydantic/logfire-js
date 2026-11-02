---
'logfire': minor
'@pydantic/logfire-browser': minor
'@pydantic/logfire-node': minor
'@pydantic/logfire-cf-workers': minor
---

Record which build produced each exception, so Logfire can resolve minified and bundled stack traces to original source.

- Exception spans and their `exception` events carry `logfire.debug_ids`, a JSON string mapping each file URL in the stack to the debug ID that a source map inject step registered in `globalThis._logfireDebugIds` (or the vendor-neutral `globalThis._debugIds`). This covers `reportError()`, failing `span()` and `instrument()` callbacks, browser global error and unhandled rejection handlers, Node process hooks, and exceptions that instrumentations record. Without a registered debug ID, spans are unchanged. `logfire` exports `DebugIdSpanProcessor` for custom tracer providers.
- When `serviceVersion` is not set, the browser, Node and Workers SDKs use the release identifier the inject step stamped into the bundle (`globalThis._logfireRelease`). Source map resolution needs a real per-build version, such as the commit SHA or release tag. The browser's `0.0.1` fallback is deprecated and is removed in the next major version.
- `@pydantic/logfire-node` adds `enableSourceMaps`, which calls `process.setSourceMapsEnabled(true)` so a service that ships `.map` files next to its code records stack traces with original files and lines, without uploading maps. Do not combine it with `source-map-support`.
