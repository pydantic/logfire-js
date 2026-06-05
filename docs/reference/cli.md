---
title: CLI
description: Use npx logfire to authenticate, select projects, and manage read tokens.
---

# CLI

The `logfire` package exposes a Node-only CLI:

```bash
npx logfire --help
```

Supported commands:

- `auth`: authenticate with Logfire and write user credentials to `~/.logfire/default.toml`.
- `auth logout`: remove user credentials.
- `projects list`: list projects where the current user can create write tokens.
- `projects new [project-name]`: create a project and write local project credentials.
- `projects use [project-name]`: create a write token for an existing project and write local project credentials.
- `read-tokens --project <org>/<project> create`: create a read token and print it to stdout.
- `whoami`: show configured user and project information.
- `clean`: remove local project credentials.
- `info`: print SDK and runtime information.

The JavaScript CLI does not implement Python SDK commands such as `run`, `inspect`, `gateway`, or `prompt`.

## Global options

- `--version`: print the CLI, Node.js, and platform versions, then exit.
- `--region <region>`: select a Logfire data region (`us` or `eu`).
- `--base-url <url>`: target a self-hosted or custom Logfire API. Mutually exclusive with `--region`.

## Auth

Authenticate once per machine:

```bash
npx logfire auth
```

Use `--region` or `--base-url` to select a specific Logfire API:

```bash
npx logfire --region us auth
npx logfire --base-url https://logfire-us.pydantic.dev auth
```

User auth tokens are stored in `~/.logfire/default.toml`, using the same token section shape as the Python SDK.

Log out to remove stored user tokens:

```bash
npx logfire auth logout
```

By default this removes every stored user token. Pass `--region` or `--base-url` to log out from only one Logfire API:

```bash
npx logfire --region eu auth logout
```

## Projects

Configure the current Node.js project to use an existing Logfire project:

```bash
npx logfire projects use my-project
```

Or create a new project:

```bash
npx logfire projects new my-project
```

Both commands write `.logfire/logfire_credentials.json` and `.logfire/.gitignore`. The Node.js runtime package reads those local credentials when no explicit `token` and no `LOGFIRE_TOKEN` are set.

Pass `--data-dir <dir>` to write credentials somewhere other than `.logfire`.

## Whoami and clean

Show the configured user and project for the current directory:

```bash
npx logfire whoami
```

Remove the local project credentials written by `projects use/new`:

```bash
npx logfire clean
```

Both commands accept `--data-dir <dir>` to read or remove credentials from a directory other than `.logfire`. `whoami` resolves project information from `LOGFIRE_TOKEN`, then global user auth, then local credentials, matching the Node.js runtime precedence.

## Browser Safety

Local credential files are Node-only. Browser code must not receive a Logfire write token; configure `@pydantic/logfire-browser` with a backend `traceUrl` proxy instead.
