## Goal

Move `@pydantic/otel-cf-workers` from the hard-fork repository
`pydantic/otel-cf-workers` into this `pydantic/logfire-js` monorepo, unify its OpenTelemetry
dependencies with the workspace catalog, publish it from this repository, and archive the old
repository.

The target end state is:

- `packages/otel-cf-workers` publishes `@pydantic/otel-cf-workers`.
- `packages/logfire-cf-workers` depends on `@pydantic/otel-cf-workers` through `workspace:*`.
- Both Cloudflare packages publish ESM-only artifacts.
- The old `pydantic/otel-cf-workers` repository is no longer the source of truth and points users
  to `pydantic/logfire-js`.

## Why

- `pydantic/otel-cf-workers` is now a hard fork, so maintaining it separately adds release,
  dependency, and review overhead.
- `@pydantic/logfire-cf-workers` is already a thin Logfire wrapper around
  `@pydantic/otel-cf-workers`; keeping them in separate repositories obscures the real ownership
  boundary.
- The monorepo already centralizes OpenTelemetry versions through `pnpm-workspace.yaml`; bringing
  the lower-level package here prevents drift between the wrapper and the Worker instrumentation
  implementation.
- Publishing from one release pipeline makes dependency updates, security overrides, changesets,
  documentation, and examples easier to keep coherent.

## Success Criteria

- [ ] `@pydantic/otel-cf-workers` source exists under `packages/otel-cf-workers` and is included in
      the workspace package set.
- [ ] `@pydantic/otel-cf-workers` package metadata points to `pydantic/logfire-js` with
      `"directory": "packages/otel-cf-workers"`.
- [ ] `@pydantic/otel-cf-workers` uses workspace catalog OpenTelemetry versions and has no
      standalone lockfile, release workflow, changeset config, Husky config, or package manager
      pin.
- [ ] `@pydantic/logfire-cf-workers` depends on `@pydantic/otel-cf-workers` as `workspace:*`.
- [ ] Both `@pydantic/otel-cf-workers` and `@pydantic/logfire-cf-workers` publish ESM-only package
      exports. There is no `require` condition, CJS build artifact, or `.d.cts` declaration output.
- [ ] Existing public import paths remain valid for ESM consumers:
      `import { instrument } from '@pydantic/otel-cf-workers'` and
      `import { instrument } from '@pydantic/logfire-cf-workers'`.
- [ ] `@pydantic/logfire-cf-workers` still exposes its current Logfire wrapper API:
      `instrument`, `instrumentInProcess`, `instrumentTail`, `getTailConfig`, and
      `exportTailEventsToLogfire`.
- [ ] The lower-level package still exposes its current public Worker instrumentation API,
      including `instrument`, `instrumentDO`, `waitUntilTrace`, `__unwrappedFetch`, `withNextSpan`,
      `OTLPExporter`, `BatchTraceSpanProcessor`, and exported types.
- [ ] Package telemetry uses this repository's build-time version pattern instead of a generated
      standalone `versions.json`.
- [ ] BSD-3-Clause licensing/provenance for the imported package and vendored code is preserved.
- [ ] Cloudflare docs and package READMEs no longer describe `@pydantic/otel-cf-workers` as an
      external underlying package from a separate repo.
- [ ] User-facing docs position `@pydantic/logfire-cf-workers` as the Cloudflare package.
      `@pydantic/otel-cf-workers` remains available for direct ESM imports, but is documented as an
      implementation package rather than the primary user path.
- [ ] Changesets cover `@pydantic/otel-cf-workers` and `@pydantic/logfire-cf-workers`, including
      the ESM-only packaging change and stable `1.0.0` publishing direction.
- [ ] The old GitHub repository can be archived after the new packages are published from this
      monorepo and npm metadata points at `pydantic/logfire-js`.
- [ ] The old `pydantic/otel-cf-workers` README is updated to point to this monorepo before the old
      repository is archived.

## Clarifications

### Session 2026-07-01

- Q: Should `@pydantic/otel-cf-workers` continue as `1.0.0-rc.N`, or should the monorepo publish
  make it stable? Should `@pydantic/logfire-cf-workers` stay `0.x` or move to stable because
  ESM-only is a breaking package-shape change? -> A: Make it stable. Interpret this PRP as moving
  both Cloudflare packages to stable `1.0.0` releases as part of the monorepo migration.
- Q: Should the imported package fully conform to this repo's lint/TS rules, or are scoped
  exceptions acceptable? -> A: Scoped exceptions are acceptable, but fix the easy issues. Use
  exceptions mainly for vendored code or Worker proxy-heavy internals where refactoring would add
  behavior risk.
- Q: Should `@pydantic/otel-cf-workers` be documented as a public advanced package or mostly as an
  implementation package? -> A: Treat it as an implementation package. Keep enough README/npm docs
  for direct users, but user-facing Logfire docs should route Cloudflare users through
  `@pydantic/logfire-cf-workers`.
- Q: Should updating the old repo README before archive be part of implementation or a manual
  post-publish step? -> A: Include it in the plan.

## Context

### Key Files

- `pnpm-workspace.yaml` - workspace package globs, strict peer settings, OpenTelemetry catalog
  versions, overrides, and allowed native builds.
- `package.json` - root build/test/release scripts. Release publishes all workspace packages via
  `pnpm publish -r --access public`.
- `.github/workflows/main.yml` - CI and release workflow. Package build, static checks,
  typecheck, tests, changesets release, and GitHub release creation all happen here.
- `tsconfig.base.json` - strict TypeScript baseline for package typecheck. The imported source
  currently needs cleanup if it extends this file directly.
- `packages/logfire-cf-workers/package.json` - current wrapper package metadata and dependency on
  npm `@pydantic/otel-cf-workers`.
- `packages/logfire-cf-workers/src/index.ts` - wrapper integration point that imports
  `TraceConfig` and `instrument` from `@pydantic/otel-cf-workers`.
- `packages/logfire-cf-workers/vite.config.ts` - current build config; currently emits ESM and CJS
  and marks `@pydantic/otel-cf-workers` as `neverBundle`.
- `packages/logfire-cf-workers/src/index.test.ts` - existing wrapper API regression tests.
- `packages/logfire-cf-workers/README.md` - package README that currently references the
  underlying lower-level package.
- `docs/packages/cloudflare.md` - user-facing Cloudflare docs that currently describe delegation
  to `@pydantic/otel-cf-workers`.
- `README.md` - top-level Cloudflare quickstart.
- `examples/cf-worker`, `examples/cf-producer-worker`, `examples/cf-tail-worker` - Worker examples
  that validate consumer-facing integration with `@pydantic/logfire-cf-workers`.
- `LICENSE` - monorepo MIT license. Do not use this as the only license file for the BSD package
  without preserving BSD notices.

### External Source Snapshot

Source repository:

- `https://github.com/pydantic/otel-cf-workers`
- Current package: `@pydantic/otel-cf-workers@1.0.0-rc.56`
- License: `BSD-3-Clause`
- GitHub repo state checked during investigation:
  - public fork of `evanderkoogh/otel-cf-workers`
  - issues disabled
  - no open PRs
  - not archived
- npm state checked during investigation:
  - `latest` is `1.0.0-rc.56`
  - versions published: `1.0.0-rc.50` through `1.0.0-rc.56`
  - repository metadata still points to `pydantic/otel-cf-workers`

Important files from the external repo:

- `package.json` - standalone package scripts, dependencies, peer dependencies, `tsup` packaging,
  BSD license, and old repository metadata.
- `src/index.ts` - public exports.
- `src/sdk.ts` - Worker handler instrumentation, package telemetry resource attributes, generated
  `versions.json` usage.
- `src/config.ts` - `TraceConfig` parsing and `BatchTraceSpanProcessor` wiring.
- `src/provider.ts`, `src/tracer.ts`, `src/span.ts`, `src/spanprocessor.ts` - custom Worker
  OpenTelemetry provider/tracer/span implementation.
- `src/context.ts`, `src/buffer.ts` - Node compatibility imports used in Workers with
  `nodejs_compat`.
- `src/instrumentation/*` - fetch, queue, scheduled, email, Durable Object, DO storage, KV, D1,
  cache, service binding, version metadata, and Analytics Engine instrumentation.
- `src/vendor/ts-checked-fsm/*` - vendored FSM helper with its own license.
- `test/*` - existing import, wrap, and DO storage tests.
- `README.md` and examples - lower-level package docs and Cloudflare runtime notes.

### External References

- [pydantic/otel-cf-workers](https://github.com/pydantic/otel-cf-workers) - current fork to import.
- [npm: @pydantic/otel-cf-workers](https://www.npmjs.com/package/@pydantic/otel-cf-workers) -
  package metadata, versions, and current dist-tags.
- [Cloudflare Workers Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) -
  required because the package uses `node:async_hooks`, `node:events`, and `node:buffer`.
- [Cloudflare Workers TypeScript types](https://www.npmjs.com/package/@cloudflare/workers-types) -
  required for Worker runtime globals and `Request.cf`.
- [OpenTelemetry JS packages](https://github.com/open-telemetry/opentelemetry-js) - stable 2.x SDK
  packages and experimental 0.x exporter packages used through the workspace catalog.
- [Changesets](https://github.com/changesets/changesets) - monorepo versioning and publish flow.

### Investigation Notes

- The current wrapper already imports the lower-level package directly:
  `packages/logfire-cf-workers/src/index.ts`.
- The monorepo currently catalogs OpenTelemetry around:
  - `@opentelemetry/api` `^1.9.1`
  - stable SDK packages `^2.8.0`
  - experimental exporter/transformer packages `>=0.219.0 <0.300.0`
  - `@opentelemetry/semantic-conventions` `^1.41.1`
- The external package CI passed after upgrading its OpenTelemetry dependencies to the monorepo
  catalog versions during investigation.
- The external package requires generated `versions.json` before typecheck/import tests in its
  standalone workflow. In this monorepo, prefer replacing that with `PACKAGE_VERSION` define
  injection rather than preserving a generated file.
- The external source does not pass this repo's strict TypeScript/lint/format settings as-is.
  Expect mechanical cleanup for:
  - `import type` under `verbatimModuleSyntax`
  - `exactOptionalPropertyTypes`
  - `erasableSyntaxOnly` rejecting constructor parameter properties
  - explicit module boundary return types
  - disallowed `Function`/`any` patterns where linted
  - skipped tests under repo lint rules
  - vendored FSM lint exceptions or targeted refactor
  - formatting conversion from Prettier tabs to `vp fmt`
- The package already requires `nodejs_compat`; this is not a new consumer requirement because
  current Logfire Cloudflare docs already require it.
- The old repo has no open PRs and issues are disabled, so archival has low collaboration risk.

### Gotchas

- Do not collapse the lower-level package into `@pydantic/logfire-cf-workers` unless maintainers
  explicitly accept breaking direct users of `@pydantic/otel-cf-workers`. This PRP preserves the
  package.
- ESM-only packaging is an intentional breaking/package-shape change. Remove CJS outputs and
  `require` exports consistently from both packages, and document this in changesets.
- `resolvePeersFromWorkspaceRoot: false` means every package that imports a peer for local
  typecheck/test also needs the dependency in its own `devDependencies` or `dependencies`.
- `@pydantic/otel-cf-workers` imports `@opentelemetry/api` directly but currently declares it only
  as a peer in the standalone package. In this monorepo, keep the peer for consumers and add a
  local dev dependency for package checks.
- The lower-level package currently has runtime dependencies on OpenTelemetry SDK/exporter
  packages, not just peers. Decide dependency vs peer deliberately. If consumers import this
  package directly, dependencies are acceptable for implementation-owned SDK pieces; peer
  `@opentelemetry/api` should remain to avoid duplicate API globals.
- `@pydantic/logfire-cf-workers` currently marks `@pydantic/otel-cf-workers` as `neverBundle`.
  Keep it external if publishing two packages, otherwise the wrapper package will include the
  implementation and undermine separate package publication.
- The old package's CJS import tests will become invalid after ESM-only conversion. Replace them
  with ESM import tests and package export smoke tests.
- `package.json` `types` should point to the ESM declaration file that matches the only export.
  Avoid stale `.d.cts` files.
- Make the stable release explicit in package metadata and changesets. The intended migration is
  `@pydantic/otel-cf-workers@1.0.0` and `@pydantic/logfire-cf-workers@1.0.0`, not another RC.
- Preserve `sideEffects` carefully. `src/buffer.ts` mutates `globalThis.Buffer` and is imported
  through the public entrypoint. If the package stays `"sideEffects": false`, verify bundlers do
  not drop required side effects.
- Preserve vendored license notices for `src/vendor/ts-checked-fsm`.
- Do not archive `pydantic/otel-cf-workers` until the first monorepo-published package version is
  available on npm and npm repository metadata points at `pydantic/logfire-js`.

## Non-Goals

- No behavior redesign of Cloudflare instrumentation beyond changes needed for migration,
  dependency unification, and ESM-only packaging.
- No merge into the core `logfire` package.
- No removal of `@pydantic/otel-cf-workers` as an npm package.
- No browser or Node runtime instrumentation changes.
- No live Cloudflare deployment tests unless credentials and deployment targets already exist.
- No changes to the upstream `evanderkoogh/otel-cf-workers` repository.
- No attempt to preserve CommonJS consumers for these two Cloudflare packages.

## Implementation Blueprint

### Package Shape

Recommended `@pydantic/otel-cf-workers` package shape:

```json
{
  "name": "@pydantic/otel-cf-workers",
  "type": "module",
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  }
}
```

Recommended `@pydantic/logfire-cf-workers` ESM-only export shape should match the same pattern.

### Tasks

```yaml
Task 1: Import lower-level package source
  CREATE packages/otel-cf-workers:
    - Copy source, tests, README, changelog, and relevant license files from pydantic/otel-cf-workers.
    - Do not copy standalone repo files that conflict with monorepo ownership:
      .github workflows, pnpm-lock.yaml, .changeset config, Husky config, packageManager pin,
      standalone examples unless a specific example is useful.
    - Preserve src/vendor/ts-checked-fsm/LICENSE.
  PATTERN:
    - packages/logfire-cf-workers for package layout.

Task 2: Convert package metadata to monorepo ownership
  MODIFY packages/otel-cf-workers/package.json:
    - Set repository to git+https://github.com/pydantic/logfire-js.git with directory
      packages/otel-cf-workers.
    - Keep license BSD-3-Clause.
    - Add publishConfig access public.
    - Use scripts based on vp: dev, build, lint, preview, typecheck, test.
    - Remove standalone scripts: clean, build:versions, build:src, cs-version, cs-publish,
      release, ci, prepare, lint-staged.
    - Replace standalone dependency versions with catalog/workspace versions.
    - Keep @opentelemetry/api as peerDependency and add it as devDependency for local checks.
  MODIFY AGENTS.md:
    - Add packages/otel-cf-workers to Repository Layout.

Task 3: Replace standalone build with Vite+
  CREATE packages/otel-cf-workers/vite.config.ts:
    - Use defineConfig from vite-plus.
    - Use PACKAGE_VERSION define, matching packages/logfire-node and packages/logfire-browser.
    - Use entry src/index.ts.
    - Emit ESM only.
    - Generate .d.ts only.
    - Preserve external dependencies with deps.neverBundle for @opentelemetry/* and node:*.
  CREATE packages/otel-cf-workers/src/vite-env.d.ts:
    - Declare PACKAGE_VERSION.
  MODIFY package source:
    - Replace versions.json import and lookup in src/sdk.ts with PACKAGE_VERSION and a stable
      package name string.
    - Remove generated versions.json assumptions from tests/typecheck.

Task 4: Make source pass monorepo TypeScript settings
  MODIFY packages/otel-cf-workers/tsconfig.json:
    - Extend ../../tsconfig.base.json.
    - Include src, tests if tests typecheck through tsc, and vite.config.ts.
    - Use Cloudflare worker types.
    - Avoid DOM lib conflicts that erase Cloudflare Request.cf; if needed, set lib to ES2022 and
      rely on @cloudflare/workers-types.
  MODIFY packages/otel-cf-workers/src/**/*.ts:
    - Add type-only imports required by verbatimModuleSyntax.
    - Fix exactOptionalPropertyTypes by omitting optional properties instead of assigning
      undefined.
    - Replace constructor parameter properties rejected by erasableSyntaxOnly.
    - Replace or isolate ts-ignore comments.
    - Add explicit return types for exported functions where lint requires.

Task 5: Make lint/format pass without hiding real issues
  MODIFY packages/otel-cf-workers/src/**/*.ts and test files:
    - Run vp fmt on imported files.
    - Address repo lint findings that are straightforward and low risk.
    - For vendored code, prefer a narrow lint exclusion or local rule override if refactoring would
      obscure provenance.
    - For Worker proxy-heavy internals, prefer narrow lint suppressions over risky refactors when
      fixing the lint issue would obscure behavior.
    - Replace CJS package import tests with ESM-only package export tests.
    - Remove or justify skipped tests. If keeping skipped tests is necessary, add a narrow lint
      suppression with a reason.

Task 6: Convert logfire Cloudflare wrapper to workspace dependency and ESM-only
  MODIFY packages/logfire-cf-workers/package.json:
    - Change @pydantic/otel-cf-workers dependency to workspace:*.
    - Remove main/module/exports require condition and .d.cts references.
    - Keep ESM import/types/default export only.
    - Consider adding @opentelemetry/api if direct local type/test needs emerge.
  MODIFY packages/logfire-cf-workers/vite.config.ts:
    - Emit ESM only.
    - Remove copyCjsDeclarations and .d.cts handling.
    - Keep @pydantic/otel-cf-workers in neverBundle.
  MODIFY packages/logfire-cf-workers tests:
    - Keep default export and named export regression coverage.
    - Add package export smoke coverage if useful.

Task 7: Update workspace dependency graph and lockfile
  MODIFY pnpm-lock.yaml:
    - Run vp install after package metadata changes.
    - Verify npm @pydantic/otel-cf-workers tarball dependency is removed from the lockfile for the
      wrapper package.
    - Verify OpenTelemetry versions resolve through catalog ranges.

Task 8: Update docs and examples
  MODIFY docs/packages/cloudflare.md:
    - Remove wording that describes the lower-level package as an external dependency/repo.
    - Keep nodejs_compat requirement.
    - Route users through @pydantic/logfire-cf-workers.
    - Do not present @pydantic/otel-cf-workers as the primary public Cloudflare SDK.
  MODIFY packages/logfire-cf-workers/README.md:
    - Same wording cleanup as docs.
  MODIFY packages/otel-cf-workers/README.md:
    - Point issues/contributing to pydantic/logfire-js.
    - Keep enough lower-level direct usage docs for existing/direct ESM consumers.
    - Position the package as implementation-level, with @pydantic/logfire-cf-workers as the
      recommended Logfire user entrypoint.
    - Document ESM-only import usage.
  MODIFY README.md if needed:
    - Keep Cloudflare quickstart aligned with package docs.
  VERIFY examples:
    - Ensure cf-worker, cf-producer-worker, and cf-tail-worker still install against workspace
      packages and typecheck/build.

Task 9: Add changesets
  CREATE .changeset/*.md:
    - @pydantic/otel-cf-workers: stable 1.0.0 release from this monorepo with unified
      OpenTelemetry catalog and ESM-only packaging.
    - @pydantic/logfire-cf-workers: stable 1.0.0 release noting the workspace dependency/internal
      source move and ESM-only packaging.
    - Use major changesets for both packages.

Task 10: Publish and archive follow-up
  AFTER MERGE/PUBLISH:
    - Confirm npm @pydantic/otel-cf-workers latest version has repository metadata pointing to
      pydantic/logfire-js.
    - Update old repo README to say development moved to pydantic/logfire-js/packages/otel-cf-workers.
    - Land the old repo README update before archiving so the archived repo remains self-explanatory.
    - Archive pydantic/otel-cf-workers.
    - Do not archive before npm publication succeeds.
```

### Integration Points

```yaml
WORKSPACE:
  - pnpm-workspace.yaml: package glob already includes packages/*; no new glob needed if using packages/otel-cf-workers.
      catalog owns OpenTelemetry versions.

BUILD:
  - packages/otel-cf-workers/vite.config.ts: new ESM-only Vite+ package build.
  - packages/logfire-cf-workers/vite.config.ts: remove CJS output and keep lower-level package external.

RELEASE:
  - .github/workflows/main.yml: no workflow change expected if package scripts follow existing package conventions.
  - .changeset/*.md: required for published packages.

RUNTIME:
  - packages/logfire-cf-workers/src/index.ts: import from workspace package should be source-compatible.
  - packages/otel-cf-workers/src/sdk.ts: replace versions.json with PACKAGE_VERSION.

DOCS:
  - docs/packages/cloudflare.md: user-facing docs.
  - packages/logfire-cf-workers/README.md: npm README.
  - packages/otel-cf-workers/README.md: direct package README.

OLD_REPO:
  - pydantic/otel-cf-workers: update README and archive only after successful monorepo publish.
```

## Validation

Run validation from the repository root through Vite+ so the pinned Node and pnpm versions are used.

```bash
# Install/update lockfile after adding the workspace package
vp install

# Lower-level package gates
vp run @pydantic/otel-cf-workers#build
vp run @pydantic/otel-cf-workers#typecheck
vp run @pydantic/otel-cf-workers#test

# Wrapper package gates
vp run @pydantic/logfire-cf-workers#build
vp run @pydantic/logfire-cf-workers#typecheck
vp run @pydantic/logfire-cf-workers#test

# Workspace static checks
vp check

# Full package checks when ready
vp run --filter "./packages/*" build
vp run --filter "./packages/*" typecheck
vp run --filter "./packages/*" test
```

If package examples are touched or the package export shape changes unexpectedly, also run:

```bash
vp run @pydantic/cf-worker#cf-typegen
vp run @pydantic/cf-worker#dev
```

Use the example commands only when local Wrangler setup is available. Otherwise, at minimum run
the package-level build/typecheck/test gates and document the skipped Worker runtime check.

### Required Test Coverage

- [ ] `@pydantic/otel-cf-workers` can be imported as ESM from its package root.
- [ ] The package root exposes expected public exports after migration.
- [ ] `instrument()` still wraps Worker handlers and preserves existing fetch instrumentation tests.
- [ ] `instrumentDO()` and DO storage instrumentation keep existing behavior.
- [ ] Package telemetry resource attributes include package name and version without
      `versions.json`.
- [ ] `@pydantic/logfire-cf-workers` default export still exposes the Cloudflare runtime
      `instrument`, not the core `logfire.instrument`.
- [ ] `instrumentInProcess()` still builds a `TraceConfig` with Logfire exporter URL, auth header,
      ULID generator, post-processing, scrubbing behavior, optional console exporter, and
      environment handling.
- [ ] `instrumentTail()` still uses `TailWorkerExporter`.
- [ ] ESM-only package export tests fail clearly if `require` or `.d.cts` artifacts return.

## Rollout Plan

1. Land the code migration and ESM-only package changes in this monorepo.
2. Publish new versions from the monorepo release workflow.
3. Verify npm metadata and tarball contents for both Cloudflare packages:
   - ESM-only exports
   - correct repository directory
   - expected license files/notices
   - no stale CJS declarations
4. Update `pydantic/otel-cf-workers` README to point to
   `pydantic/logfire-js/tree/main/packages/otel-cf-workers`, and land that README update in the
   old repository.
5. Archive `pydantic/otel-cf-workers`.

## Unknowns & Risks

- ESM-only and stable `1.0.0` releases are intentional for this PRP. This is a breaking package
  shape for any CommonJS consumers.
- The imported package may need lint exceptions for vendored and Worker-proxy-heavy code. Fix easy
  lint/type issues, but avoid broad behavior refactors while satisfying lint.
- `sideEffects: false` may be unsafe because `src/buffer.ts` mutates `globalThis.Buffer`. Verify
  bundling behavior or remove/adjust `sideEffects`.
- Worker runtime smoke testing may require local Wrangler credentials/configuration not available
  in CI.
- `@pydantic/otel-cf-workers` direct consumers may rely on CJS despite the package being RC.
  Changeset and README should make ESM-only explicit.
- npm dist-tags for the lower-level package currently treat an RC as `latest`. Publishing stable
  `1.0.0` from the monorepo should replace that `latest` path.
- The old repo is a fork, so GitHub archival preserves visible fork history but active development
  history will continue in a different repository. Keep README guidance explicit.

**Confidence: 8/10** for one-pass implementation success if execution treats TypeScript/lint
cleanup as part of the migration rather than a follow-up.
