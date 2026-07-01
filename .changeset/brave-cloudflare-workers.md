---
"@pydantic/logfire-cf-workers": major
"@pydantic/otel-cf-workers": patch
---

Move the Cloudflare Worker OpenTelemetry implementation into the monorepo and publish Cloudflare packages as stable ESM-only packages.

`@pydantic/logfire-cf-workers` now depends on the workspace `@pydantic/otel-cf-workers` package and no longer publishes CommonJS exports or `.d.cts` declarations. `@pydantic/otel-cf-workers` is published from this repository with unified OpenTelemetry catalog dependencies and ESM-only package exports.
