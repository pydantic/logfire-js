---
'logfire': patch
'@pydantic/logfire-browser': patch
---

Report the correct package version at runtime. `PACKAGE_VERSION` was read from the ambient `npm_package_version` environment variable at build time, which resolves to whichever `package.json` the build was started from. Releases run `pnpm run build` from the repository root, so published artifacts were stamped with the private root version `1.0.0` instead of their own: `logfire@0.21.8` reported `Running Logfire 1.0.0` from `logfire --version` and `logfire info`, and sent `logfire-js/1.0.0` as its CLI user agent. `@pydantic/logfire-browser` reported the same wrong value as the `telemetry.sdk.version` resource attribute on every browser span.

Each package now reads the version from its own `package.json`, matching what `@pydantic/logfire-node`, `@pydantic/logfire-cf-workers`, and `@pydantic/otel-cf-workers` already did.
