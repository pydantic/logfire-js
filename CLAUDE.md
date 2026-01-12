# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a monorepo for the **Pydantic Logfire JavaScript SDK** - an observability platform built on OpenTelemetry. The repository contains multiple packages for different JavaScript runtimes (Node.js, browsers, Cloudflare Workers, etc.) and usage examples.

## Repository Structure

This is a **pnpm workspace monorepo**:

- `packages/logfire-node` - Node.js SDK with automatic OpenTelemetry instrumentation
- `packages/logfire-api` - Core API package (published as `logfire`) that can be used standalone for manual tracing (no auto-instrumentation)
- `packages/logfire-cf-workers` - Cloudflare Workers integration
- `packages/logfire-browser` - Browser/web SDK
- `packages/tooling-config` - Shared build and linting configuration
- `examples/` - Working examples for various platforms (Express, Next.js, Deno, Cloudflare Workers, etc.)

## Core Architecture

### Package Relationships

- `logfire` (published from `packages/logfire-api`) is the base package that provides the core tracing API (`span`, `info`, `debug`, `error`, etc.) - it wraps OpenTelemetry's trace API with convenience methods
- `@pydantic/logfire-node` (from `packages/logfire-node`) depends on `logfire` and adds automatic instrumentation via `@opentelemetry/auto-instrumentations-node`
- `@pydantic/logfire-cf-workers` depends on `logfire` and adds Cloudflare Workers-specific instrumentation
- `@pydantic/logfire-browser` depends on `logfire` and adds browser-specific instrumentation

### Key Concepts

**Trace API** (`logfire` package):

- Provides convenience wrappers around OpenTelemetry spans with log levels (trace, debug, info, notice, warn, error, fatal)
- Uses message template formatting with attribute extraction (see `formatter.ts`)
- Uses ULID for trace ID generation (see `ULIDGenerator.ts`)
- Supports attribute scrubbing for sensitive data (see `AttributeScrubber.ts`)

**Configuration** (`@pydantic/logfire-node` package):

- `configure()` function in `logfireConfig.ts` handles SDK initialization
- Configuration can be provided programmatically or via environment variables:
  - `LOGFIRE_TOKEN` - Authentication token
  - `LOGFIRE_SERVICE_NAME` - Service name
  - `LOGFIRE_SERVICE_VERSION` - Service version
  - `LOGFIRE_ENVIRONMENT` - Deployment environment
  - `LOGFIRE_CONSOLE` - Enable console output
  - `LOGFIRE_SEND_TO_LOGFIRE` - Toggle sending to Logfire backend
  - `LOGFIRE_DISTRIBUTED_TRACING` - Enable/disable trace context propagation

**Span Creation**:

- `startSpan()` - Creates a span without setting it on context (manual mode)
- `span()` - Creates a span, executes a callback, and auto-ends the span (recommended)
- `info()`, `debug()`, `error()`, etc. - Convenience methods that create log-type spans
- All spans use message templates with attribute extraction (e.g., `"User {user_id} logged in"`)

## Common Commands

### Development Setup

```bash
pnpm install
```

### Building

```bash
# Build all packages
pnpm run build

# Build in watch mode (for development)
pnpm run dev
```

### Testing

```bash
# Run all tests
pnpm run test

# Run tests for a specific package
cd packages/logfire-node && pnpm test
```

### Linting, Type Checking, and Formatting

```bash
# Run full CI pipeline (build, typecheck, lint, format-check, test)
pnpm run ci

# Individual commands
pnpm run typecheck    # Type checking
pnpm run lint         # Linting
pnpm run format-check # Check formatting
pnpm run format       # Fix formatting
```

### Working with Examples

Start an example to test changes:

```bash
# Navigate to an example
cd examples/node  # or express, nextjs, cf-worker, etc.

# Install dependencies (if needed)
pnpm install

# Run the example (check the example's package.json for scripts)
pnpm start  # or pnpm run dev
```

### Changesets (Version Management)

This project uses Changesets for version management:

```bash
# Add a changeset when making changes
pnpm run changeset-add

# Publish packages (maintainers only)
pnpm run release
```

### Running a Single Test

```bash
# Navigate to the package
cd packages/logfire-api  # or packages/logfire-node

# Run vitest with a filter
pnpm test -- -t "test name pattern"
```

## Development Workflow

1. Make changes in `packages/` source code
2. Run `pnpm run build` to rebuild packages (or `pnpm run dev` for watch mode)
3. Test changes using examples in `examples/` directory
4. Run `pnpm run ci` to ensure all checks pass (build, typecheck, lint, format, test)
5. Add a changeset if the changes warrant a version bump: `pnpm run changeset-add`

## Important Implementation Details

### Message Template Formatting

The `logfireFormatWithExtras()` function in `formatter.ts` extracts attributes from message templates. For example:

- `"User {user_id} logged in"` with `{ user_id: 123 }` becomes formatted message `"User 123 logged in"`
- Extracted attributes are stored with special keys and used by the Logfire backend

### Attribute Scrubbing

Sensitive data scrubbing is handled in `AttributeScrubber.ts`. By default, it redacts common sensitive patterns (passwords, tokens, API keys, etc.) using regex patterns.

### Span Types

Spans have a `logfire.span_type` attribute:

- `"log"` - Point-in-time events (no child spans expected)
- `"span"` - Duration-based traces (can have child spans)

### ID Generation

The SDK uses ULID (Universally Unique Lexicographically Sortable Identifier) for trace IDs by default, which provides time-ordered IDs for better performance.

### Build System

- Uses Vite for building packages (see individual `vite.config.ts` files)
- Shared Vite config is in `packages/tooling-config/vite-config.ts`
- Outputs both ESM (`.js`) and CommonJS (`.cjs`) formats with corresponding TypeScript definitions

## Testing Notes

- Tests use Vitest
- Some packages have minimal tests (`--passWithNoTests` flag in package.json)
- Test files are located alongside source files with `.test.ts` extension

## Node Version

The project requires **Node.js 22** (see `engines` in root package.json).

## Package Manager

Uses **pnpm 10.28.0** (enforced via `packageManager` field).
