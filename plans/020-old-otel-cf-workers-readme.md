# `pydantic/otel-cf-workers` Archive README Draft

Use this README replacement in `pydantic/otel-cf-workers` after the first monorepo-published
`@pydantic/otel-cf-workers` version is available on npm and npm metadata points at
`pydantic/logfire-js`.

```md
# @pydantic/otel-cf-workers has moved

Development of `@pydantic/otel-cf-workers` has moved to the Pydantic Logfire JavaScript SDK
monorepo:

https://github.com/pydantic/logfire-js/tree/main/packages/otel-cf-workers

This repository is archived and is no longer the source of truth for code, releases, issues, or
pull requests.

## Packages

- Logfire Cloudflare Workers users should use `@pydantic/logfire-cf-workers`:
  https://logfire.pydantic.dev/docs/packages/cloudflare/
- Direct lower-level OpenTelemetry users can continue using `@pydantic/otel-cf-workers`, now
  published from `pydantic/logfire-js`.

## Migration Notes

The monorepo-published package is ESM-only. Use ESM `import` syntax; CommonJS `require()` is not
supported.

Please open issues and pull requests in `pydantic/logfire-js`:

https://github.com/pydantic/logfire-js/issues
```
