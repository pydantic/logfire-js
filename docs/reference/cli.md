---
title: CLI
description: Use npx logfire to authenticate, connect projects, and query telemetry.
---

# CLI

The `logfire` package delegates its `logfire` command to the native Logfire CLI:

```bash
npx logfire --help
```

The optional native package contains one binary for the current operating system
and architecture. If optional dependencies are disabled, reinstall without
`--omit=optional` or `--no-optional` before using the command. Importing the
JavaScript SDK does not execute the CLI.

## Version

```bash
npx logfire --version
```

This reports both the native CLI version and the JavaScript SDK version that
invoked it.

## Authenticate

Sign in with your browser and store the OAuth session in the operating system
credential store:

```bash
npx logfire --region us auth
npx logfire auth whoami
```

Use `--region eu` for the EU service, `--base-url` for a self-hosted service, and
`--org` to select an exact organization. List remembered profiles without opening
the credential store with `npx logfire auth status`.

## Connect a project

Choose an existing project interactively:

```bash
npx logfire init
```

Or make the choice explicit for scripts and coding agents:

```bash
npx logfire --org my-org --no-input init use --name my-project --permission send
```

To create a project instead, use `init new --name my-project`. These commands
write `.logfire/logfire_credentials.json` and protect it with a local
`.gitignore`. The Node.js SDK reads that project credential when neither an
explicit `token` nor `LOGFIRE_TOKEN` is set.

Inspect or remove only the local project connection with:

```bash
npx logfire project current
npx logfire project clean
```

## Query and tokens

List available projects and query recent telemetry through the hosted MCP server:

```bash
npx logfire mcp projects
npx logfire mcp query schema
npx logfire mcp query run \
  "SELECT service_name, count(*) FROM records GROUP BY service_name" \
  --project my-project
```

Create a read or write token for the project connected to the current directory:

```bash
npx logfire token read
npx logfire token write
```

Token values are printed once. Treat them as secrets and do not paste them into
logs, issues, or chat.

For non-interactive use, add `--no-input --output json` and select `--org`
explicitly. Run `npx logfire help <command>` for the complete command-specific
contract.

## Browser safety

Local credential files are Node-only. Browser applications use the restricted
token and ingest settings generated under **Frontend > Applications**. Never put
a normal Logfire write token in browser code. See the
[Browser package](../packages/browser.md) for setup.
