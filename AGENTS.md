# Agent Instructions

This file is the canonical project guide for coding agents. `CLAUDE.md` is kept as a symlink for tools that still look for that name. Keep this file tool-neutral and update it when project commands, package layout, or non-obvious conventions change.

## Project Overview

This repository is the Pydantic Logfire JavaScript SDK monorepo. It provides OpenTelemetry-based tracing and logging packages for Node.js, browsers, Cloudflare Workers, and standalone manual tracing.

## Repository Layout

- `packages/logfire-api` publishes `logfire`, the core manual tracing API.
- `packages/logfire-node` publishes `@pydantic/logfire-node`, which adds Node.js SDK setup and automatic instrumentation.
- `packages/logfire-cf-workers` publishes `@pydantic/logfire-cf-workers`, which adapts Logfire to Cloudflare Workers.
- `packages/logfire-browser` publishes `@pydantic/logfire-browser`, which adapts Logfire to browser tracing.
- `packages/tooling-config` contains shared build and lint configuration.
- `examples/` contains runnable examples for Express, Next.js, Deno, Cloudflare Workers, browser usage, and related integrations.

## Environment

- Use Node.js 24. The root `package.json` enforces this through `engines`.
- Use pnpm 10.28.0. The package manager is pinned in `packageManager`.
- Run workspace commands from the repository root unless a package-level command is explicitly needed.

## Useful Commands

Install dependencies:

```bash
pnpm install
```

Build all packages:

```bash
pnpm run build
```

Build packages in watch-style development mode:

```bash
pnpm run dev
```

Run all package tests:

```bash
pnpm run test
```

Run all checks before broad or release-oriented changes:

```bash
pnpm run check
```

Run focused checks for one package:

```bash
pnpm --filter logfire test
pnpm --filter @pydantic/logfire-node test
pnpm --filter @pydantic/logfire-browser typecheck
```

Run a single Vitest test by name from a package filter:

```bash
pnpm --filter logfire test -- -t "test name pattern"
```

Format or verify formatting:

```bash
pnpm run format
pnpm run format-check
```

Add a changeset when a package-visible change needs a release note or version bump:

```bash
pnpm run changeset-add
```

## Architecture Notes

- `logfire` wraps OpenTelemetry tracing APIs with convenience methods such as `span`, `startSpan`, `info`, `debug`, `warn`, and `error`.
- Runtime packages depend on `logfire` and add environment-specific configuration and instrumentation.
- Message templates are formatted by `logfireFormatWithExtras()` in `packages/logfire-api/src/formatter.ts`; template fields become structured attributes.
- Sensitive data scrubbing is handled by `AttributeScrubber` in `packages/logfire-api/src/AttributeScrubber.ts`.
- Trace IDs use ULIDs through `ULIDGenerator`.
- Logfire spans use `logfire.span_type`: `log` for point-in-time events and `span` for duration-based work.

## Development Conventions

- Prefer existing package patterns, helpers, and OpenTelemetry abstractions over introducing new wrappers.
- Keep changes scoped to the package or example relevant to the task.
- Update examples or docs when public behavior, configuration, or package usage changes.
- Add or update tests for behavior changes. If a package has minimal tests or `--passWithNoTests`, still run typecheck/build for that package when relevant.
- Avoid adding production dependencies without a clear need; keep workspace dependency and lockfile changes together.
- Do not put agent-specific or vendor-specific instructions here unless they are explicitly about repository compatibility. Use generic wording that applies to any coding agent.

## Testing Guidance

- Tests use Vitest and usually live alongside source files as `*.test.ts`.
- Prefer exact assertions over fuzzy matching for stable output. Use `toBe` or `toEqual` with deterministic inputs instead of `toContain` or broad regex matching.
- When testing formatted errors or stack output, mock stack strings so assertions stay deterministic.
- For changes under `packages/logfire-api/src/evals`, consider the focused coverage script:

```bash
pnpm --filter logfire run coverage:evals
```

## Package-Specific Notes

- `packages/logfire-node/src/logfireConfig.ts` owns Node SDK configuration and environment variable handling.
- Relevant environment variables include `LOGFIRE_TOKEN`, `LOGFIRE_SERVICE_NAME`, `LOGFIRE_SERVICE_VERSION`, `LOGFIRE_ENVIRONMENT`, `LOGFIRE_CONSOLE`, `LOGFIRE_SEND_TO_LOGFIRE`, and `LOGFIRE_DISTRIBUTED_TRACING`.
- `packages/logfire-api` is the base API package and should not depend on runtime-specific packages.
- Cloudflare Workers code should stay compatible with Worker runtime constraints.
- Browser code should avoid Node-only APIs.

## Examples

Use examples to validate integration behavior when package-level tests do not cover the runtime path. Check the target example's `package.json` before running it, because scripts vary by example.

Typical flow:

```bash
cd examples/express
pnpm install
pnpm run dev
```

## Agent Guidance Maintenance

- Keep this file concise and operational. Prefer links or file paths over copied explanations when the code is self-describing.
- If a subdirectory needs different build, test, or safety rules, add a nested `AGENTS.md` in that directory instead of growing this root file.
- Instructions closest to the edited file should be treated as more specific than this root file.
- Preserve the `CLAUDE.md` symlink unless the repository drops compatibility with tools that read it.
