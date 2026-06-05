## Goal

Add Python-SDK-style Logfire auth and project-management CLI support to the TypeScript SDK, exposed as `npx logfire`, while explicitly excluding `run`, `inspect`, and `gateway`.

The implementation should:

- Add a Node-only CLI entrypoint to the existing `logfire` npm package.
- Implement `auth`, `auth logout`, `whoami`, `clean`, `projects list`, `projects new`, `projects use`, `read-tokens --project <org>/<project> create`, `info`, `--version`, `--base-url`, and `--region`.
- Preserve browser safety by keeping all filesystem, environment, credential, and auth logic out of `@pydantic/logfire-browser` and out of browser-imported shared runtime modules.
- Let `@pydantic/logfire-node` read local project credentials from `.logfire/logfire_credentials.json` when no explicit token or `LOGFIRE_TOKEN` is present.
- Maintain wire/API compatibility with the Python SDK credential files and backend endpoints where practical.

## Why

- `npx logfire auth` and `npx logfire projects use/new` give JavaScript users the same onboarding flow Python users have.
- Local project credentials let Node examples and local apps work without copying write tokens into `.env`.
- Reusing Python credential file formats allows a developer authenticated by the Python SDK to use the JS SDK and vice versa.
- Keeping credential loading Node-only avoids accidental browser token exposure.

## Success Criteria

- [ ] Running `npx logfire --help` shows the supported commands and explicitly omits `run`, `inspect`, and `gateway`.
- [ ] `npx logfire auth` stores user tokens in `~/.logfire/default.toml` using a format compatible with the Python SDK.
- [ ] `npx logfire auth logout` removes all user tokens, or only the selected URL's token when `--region` or `--base-url` is provided.
- [ ] `npx logfire projects new/use` writes `.logfire/logfire_credentials.json` with `token`, `project_name`, `project_url`, and `logfire_api_url`.
- [ ] `@pydantic/logfire-node.configure()` uses local credentials only when no explicit `token` and no `LOGFIRE_TOKEN` are present.
- [ ] `@pydantic/logfire-browser` behavior and public API remain unchanged; it still requires `traceUrl` and never reads local credentials or env tokens.
- [ ] CLI command tests cover the auth/project happy paths, user-token edge cases, invalid project inputs, and file outputs.
- [ ] Docs explain `npx logfire auth`, `npx logfire projects use`, local credential precedence, and the browser exclusion.

## Clarifications

### Session 2026-06-04

- Q: Should `npx logfire` live in the existing `logfire` package or a separate CLI package? -> A: Use the existing `logfire` package and keep the CLI implementation isolated from browser-imported runtime exports.
- Q: Should Python's agent-oriented `prompt` command behavior be included? -> A: Do not implement `prompt` in this PRP.
- Q: Should the JS implementation add a TOML dependency for `~/.logfire/default.toml`? -> A: Use a narrow Python-compatible parser/writer for the current auth file shape; do not add a TOML dependency.
- Q: Should JS add configurable local credential directories? -> A: Add `dataDir?: string` and `LOGFIRE_CREDENTIALS_DIR` support.
- Q: Should local credential lookup search parent directories? -> A: No. Use the configured data dir or exact cwd `.logfire`, matching Python's default behavior.
- Q: Should `whoami` preserve Python-style fallback behavior? -> A: Yes. If env token validation cannot produce project info, continue to global user auth and local project credentials with warnings.
- Q: Should the CLI use a built `dist/cli.js` with a preserved shebang? -> A: Yes.
- Q: Should release notes be split? -> A: Use one changeset covering both `logfire` and `@pydantic/logfire-node`.

### POC Findings 2026-06-04

- Vite+ preserves `#!/usr/bin/env node` and executable bits for a CLI entry when using the repo's config shape: `pack.entry`, `pack.format`, and `outExtensions`. A temp package produced executable `dist/cli.js` and `dist/cli.cjs`; `node dist/cli.js` worked. Risk is mainly config typo: plural `entries`/`formats` was silently ignored and only package exports were built.
- Adding the CLI as a separate package entry kept normal `dist/index.js` free of CLI-only `node:fs` imports. This supports keeping the CLI inside the existing `logfire` package as long as `src/index.ts` does not import CLI modules.
- A narrow TOML reader/writer is feasible for Python's auth file shape. The POC handled comments, blank lines, unrelated sections, `[tokens."<base_url>"]`, escaped quotes/backslashes, and round-tripped token/expiration fields.
- Importing `resolveBaseUrl` from the existing `packages/logfire-api/src/logfireApiConfig.ts` into a CLI entry bundled `@opentelemetry/api` and runtime config initialization into the CLI. Do not use runtime config modules from CLI auth code. Use a small side-effect-free region/token helper instead, and optionally have runtime config import that helper later.

### Final Decisions 2026-06-04

- `clean` should manage local JS project credentials only. Do not invent JS CLI log cleanup; accept `--logs` as a no-op with a clear message if compatibility is useful.
- Create a small side-effect-free region/token/base-url helper and keep CLI auth/project code off runtime config modules.
- Match Python behavior and output shape where useful, but do not overfit exact Python text/table formatting unless tests or docs need it.
- Use one changeset with minor bumps for `logfire` and `@pydantic/logfire-node`.
- Do one manual authenticated smoke test against a live backend environment before release, in addition to mocked unit tests.

## Context

### Key Files

- `packages/logfire-api/package.json` - existing `logfire` npm package; add a `bin` entry here for `npx logfire`.
- `packages/logfire-api/vite.config.ts` - package build entries; add a CLI entry and ensure output keeps a Node shebang.
- `packages/logfire-api/src/index.ts` - public browser-safe runtime surface; do not import CLI/auth/fs modules here.
- `packages/logfire-node/src/logfireConfig.ts` - current Node config precedence; integrate local credential loading here.
- `packages/logfire-node/src/__test__/logfireConfig.test.ts` - existing config tests; add local credential precedence coverage.
- `packages/logfire-browser/src/index.ts` - browser runtime requires `traceUrl`; should remain credential-free.
- `docs/configuration.md` - token and credential precedence documentation.
- `docs/reference/environment-variables.md` - document Node local credentials and browser exclusion.
- `../logfire/logfire/_internal/cli/__init__.py` - Python CLI command shape and option behavior.
- `../logfire/logfire/_internal/cli/auth.py` - Python auth and logout behavior.
- `../logfire/logfire/_internal/auth.py` - Python global user-token TOML format and token selection.
- `../logfire/logfire/_internal/config.py` - Python local project credential format and project selection logic.
- `../logfire/logfire/_internal/client.py` - Python backend endpoints for user/org/project/read-token operations.
- `../logfire/tests/test_cli.py` and `../logfire/tests/test_auth.py` - behavior-oriented test cases to port.

### External References

- Node.js built-ins available in the repo's required Node 24 runtime:
  - `node:fs`, `node:path`, `node:os` for credential files.
  - `node:readline/promises` for interactive prompts.
  - global `fetch` for backend API calls.
  - `node:child_process` only for browser opening where needed.
- NPM package `bin` semantics: a package named `logfire` with `"bin": {"logfire": "./dist/cli.js"}` is what makes `npx logfire` invoke the CLI.

### Gotchas

- Do not import Node-only modules from `packages/logfire-api/src/index.ts` or other browser-consumed exports. Keep CLI code reachable only through the package `bin` file.
- Do not import runtime config modules such as `logfireApiConfig.ts` from CLI auth/project code. Those modules initialize OpenTelemetry-facing runtime defaults and were proven to bundle `@opentelemetry/api` into the CLI. Put region/token/base-url helpers in a small side-effect-free module.
- The existing shared `logfire` package is browser-usable. Adding a CLI must not make bundlers resolve `node:fs` from normal imports.
- `@pydantic/logfire-node.configure()` is synchronous today. Local credential loading should be synchronous JSON file reading to preserve that API.
- Browser and Cloudflare Worker runtimes should not auto-read `.logfire/logfire_credentials.json`. Node local applications should.
- Python writes global auth tokens as TOML but local project credentials as JSON. The JS CLI must support both.
- Python's `LOGFIRE_TOKEN` can contain comma-separated tokens. Local credentials contain exactly one write token.
- Python supports a configurable local credentials directory (`data_dir` / `LOGFIRE_CREDENTIALS_DIR`). JS should add matching `dataDir` / `LOGFIRE_CREDENTIALS_DIR` support for Node.
- Python currently defaults `send_to_logfire` differently than JS. Keep JS default semantics unless explicitly changed: current JS default is `if-token-present`.
- Interactive prompts must be testable without a real terminal.
- The API endpoints are backend contracts; tests should mock HTTP rather than require network access.

## Implementation Blueprint

### Data Models

```ts
type RegionId = 'us' | 'eu'

interface RegionData {
  baseUrl: string
  gcpRegion: string
}

interface UserTokenData {
  token: string
  expiration: string
}

interface UserToken {
  baseUrl: string
  token: string
  expiration: string
}

interface ProjectCredentials {
  token: string
  project_name: string
  project_url: string
  logfire_api_url: string
}

interface WritableProject {
  organization_name: string
  project_name: string
}

interface Organization {
  organization_name: string
}
```

### Tasks

```yaml
Task 1: CLI packaging
  MODIFY packages/logfire-api/package.json:
    - Add "bin": {"logfire": "./dist/cli.js"}.
    - Ensure "files" includes the built CLI output via "dist".
  MODIFY packages/logfire-api/vite.config.ts:
    - Add a cli build entry, e.g. cli: "src/cli/index.ts".
    - Add a banner/shebang for the cli entry only, or otherwise preserve "#!/usr/bin/env node".
    - Ensure Node built-ins stay external.
  CREATE packages/logfire-api/src/cli/index.ts:
    - Parse args and dispatch commands.
    - Do not export this from package runtime exports.

Task 2: Shared CLI constants and helpers
  CREATE packages/logfire-api/src/cli/regions.ts:
    - Define us/eu region metadata matching Python.
    - Implement token-region/base-url parsing without importing `logfireApiConfig.ts`.
    - Prefer a small side-effect-free helper that runtime config can later reuse, rather than importing runtime config into CLI code.
  CREATE packages/logfire-api/src/cli/errors.ts:
    - Define LogfireCliError with exitCode.
    - Centralize user-facing errors.
  CREATE packages/logfire-api/src/cli/output.ts:
    - Stderr/stdout helpers.
    - Pretty table helper for projects.
  CREATE packages/logfire-api/src/cli/interactivePrompt.ts:
    - Testable readline-based prompt helpers.
    - askChoice, askConfirm, askText.

Task 3: Credential file compatibility
  CREATE packages/logfire-api/src/cli/credentials.ts:
    - Read/write global user tokens at ~/.logfire/default.toml.
    - Preserve Python-compatible TOML sections: [tokens."<base_url>"].
    - Detect expired tokens using ISO timestamps.
    - Select matching token by base URL; prompt when multiple tokens exist and no base URL is selected.
    - Read/write local project credentials at <dataDir>/logfire_credentials.json.
    - Create data dir and write <dataDir>/.gitignore containing "*".
  CREATE packages/logfire-api/src/cli/credentials.test.ts:
    - Cover Python-compatible TOML read/write.
    - Cover missing, expired, multiple, and selected-token cases.
    - Cover local project credentials read/write and invalid JSON.

Task 4: Backend API client
  CREATE packages/logfire-api/src/cli/client.ts:
    - Implement authenticated user-token API client with global fetch.
    - Methods:
      - requestDeviceCode(baseUrl, machineName)
      - pollForToken(baseUrl, deviceCode)
      - getUserInformation()
      - getUserOrganizations()
      - getUserProjects()
      - createNewProject(org, projectName)
      - createWriteToken(org, projectName)
      - createReadToken(org, projectName)
      - getTokenInfo(writeToken, baseUrl)
    - Map known error cases to user-facing CLI errors:
      - 409 project exists
      - 422 invalid project name
      - generic retrieval/create failures
  CREATE packages/logfire-api/src/cli/client.test.ts:
    - Mock fetch for endpoint paths, headers, request bodies, and errors.

Task 5: Auth commands
  CREATE packages/logfire-api/src/cli/commands/auth.ts:
    - Implement auth region selection when no global URL/region is supplied.
    - Use device auth flow and browser open.
    - Store token in ~/.logfire/default.toml.
    - Implement logout.
  TEST:
    - Already logged in returns without mutating file.
    - Region prompt handles invalid selection then valid selection.
    - Poll retries temporary failures and fails after repeated errors.
    - Logout all, logout region-specific, not logged in, wrong region.

Task 6: Project commands
  CREATE packages/logfire-api/src/cli/commands/projects.ts:
    - Implement list/new/use.
    - Project names must match Python: /^[a-z0-9]+(?:-[a-z0-9]+)*$/.
    - Default project name should be sanitized cwd basename, max 41 chars, fallback "untitled".
    - Implement org selection:
      - Valid --org: use it.
      - One organization and no --default-org: ask confirmation.
      - Multiple organizations: use default org when --default-org and available, otherwise prompt.
    - Implement use selection:
      - Exact org/project match creates write token directly.
      - Multiple matches prompts.
      - No matches prompts whether to choose from all projects.
      - No projects prints create hint and exits success.
    - Write local credentials and print project URL.
  TEST:
    - Port Python tests for list/no projects/new/use ambiguity/invalid names/errors.

Task 7: Other supported commands
  CREATE packages/logfire-api/src/cli/commands/whoami.ts:
    - Validate LOGFIRE_TOKEN tokens first via /v1/info.
    - Otherwise use global user auth for username.
    - Then load local project credentials from --data-dir and print project URL.
  CREATE packages/logfire-api/src/cli/commands/clean.ts:
    - Delete local .gitignore and logfire_credentials.json under --data-dir.
    - Do not create or delete JS CLI log files.
    - If `--logs` is accepted for Python compatibility, treat it as a no-op with a clear message.
    - Prompt before deleting.
  CREATE packages/logfire-api/src/cli/commands/readTokens.ts:
    - Require --project org/project for create.
    - Print token to stdout.
  CREATE packages/logfire-api/src/cli/commands/info.ts:
    - Print logfire package version, platform, Node version, and selected related package versions.

Task 8: Node SDK local credential loading
  CREATE packages/logfire-node/src/credentials.ts:
    - Read `.logfire/logfire_credentials.json` synchronously.
    - Validate required fields.
    - Return undefined if missing.
    - Throw only when file exists but is invalid and no higher-precedence token exists.
  MODIFY packages/logfire-node/src/logfireConfig.ts:
    - Add a JS option for the credentials directory, e.g. dataDir?: string.
    - Resolve token as: config token -> LOGFIRE_TOKEN -> local credentials token.
    - Resolve credentials directory as: config dataDir -> LOGFIRE_CREDENTIALS_DIR -> ".logfire".
    - Resolve base URL as: config advanced.baseUrl -> LOGFIRE_BASE_URL -> local credentials logfire_api_url -> token-region inference.
    - Preserve token-provider behavior: function token still requires explicit base URL.
  MODIFY packages/logfire-node/src/__test__/logfireConfig.test.ts:
    - Add precedence tests.
    - Add dataDir / LOGFIRE_CREDENTIALS_DIR tests.
    - Add invalid local creds behavior.
    - Add `sendToLogfire: 'if-token-present'` with local creds.

Task 9: Documentation
  MODIFY docs/configuration.md:
    - Add local credentials to Node token precedence.
    - State browser never reads local credentials.
  MODIFY docs/reference/environment-variables.md:
    - Mention `.logfire/logfire_credentials.json` for Node local development.
  CREATE or MODIFY docs/reference/cli.md:
    - Document supported JS CLI commands and explicitly excluded commands.
  MODIFY README.md or docs/get-started.md:
    - Add `npx logfire auth` and `npx logfire projects use <project>`.

Task 10: Validation and release notes
  CREATE .changeset/<name>.md:
    - Add release notes for `logfire` CLI and `@pydantic/logfire-node` local credentials.
  RUN:
    - pnpm --filter logfire test
    - pnpm --filter @pydantic/logfire-node test
    - pnpm --filter logfire typecheck
    - pnpm --filter @pydantic/logfire-node typecheck
    - pnpm run format-check
```

### Integration Points

```yaml
NPM_BIN:
  - packages/logfire-api/package.json
  - Add "bin" so `npx logfire` resolves to the built CLI.

BUILD:
  - packages/logfire-api/vite.config.ts
  - Add CLI entry with `pack.entry`, not `entries`.
  - Preserve shebang via the source file and existing Vite+ behavior.
  - Keep `outExtensions` mapping so the bin can point at `dist/cli.js`.

NODE_CONFIG:
  - packages/logfire-node/src/logfireConfig.ts
  - Add local credential fallback after explicit/env tokens.

AUTH_STORE:
  - ~/.logfire/default.toml
  - Python-compatible user-token store.

PROJECT_CREDS:
  - .logfire/logfire_credentials.json
  - Python-compatible write-token store.

BROWSER:
  - packages/logfire-browser/src/index.ts
  - No changes expected except tests/docs confirming no local credential behavior.
```

## Validation

```bash
# Focused CLI/shared package tests
pnpm --filter logfire test
pnpm --filter logfire typecheck

# Focused Node config tests
pnpm --filter @pydantic/logfire-node test
pnpm --filter @pydantic/logfire-node typecheck

# Formatting
pnpm run format-check

# Optional broader check before PR
pnpm run check
```

### Required Test Coverage

- [ ] `auth` writes Python-compatible `~/.logfire/default.toml`.
- [ ] `auth logout` removes all tokens or a selected region/base URL.
- [ ] `whoami` handles env token, multiple env tokens, global user token, local project credentials, and missing credentials.
- [ ] `projects list` sorts and prints writable projects.
- [ ] `projects new` handles org selection, default org, invalid project names, duplicate names, backend errors, and writes credentials.
- [ ] `projects use` handles exact match, ambiguous match, missing project with choose-all, missing project with give-up, no projects, write-token errors, and writes credentials.
- [ ] `read-tokens create` validates `--project org/project` and prints token to stdout.
- [ ] Node `configure()` precedence: explicit token > env token > local credentials.
- [ ] Node `configure()` uses local credentials base URL when no explicit/env base URL is set.
- [ ] Browser package has no credential-loading imports or behavior.

## Unknowns & Risks

- Backend endpoint contracts may have drifted from the Python SDK tests; mock tests should encode the observed Python paths, and one manual authenticated smoke test is useful before release.
- Browser opening during `auth` is platform-sensitive and should degrade to printing the URL when opening fails.
- Vite+ CLI entry configuration is easy to mistype. Add a packaging-oriented test or build assertion that `dist/cli.js` exists, starts with `#!/usr/bin/env node`, and is executable.
- The narrow TOML parser should intentionally tolerate comments and unrelated sections, as proven in POC, but tests should lock that behavior.

**Confidence: 8/10** for one-pass implementation success with `prompt`, `run`, `inspect`, and `gateway` excluded.
