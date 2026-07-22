---
repo: /Users/petyo/w/pydantic/logfire-js
---

# Dependabot Consumer Security Fixes

## Goal

Remove the two remaining consumer-relevant Dependabot vulnerabilities from the supported `logfire` and `@pydantic/logfire-node` dependency contracts:

- require `js-yaml` 4.3.0+ and verify merge-key amplification is rejected through the public dataset parser; and
- require an OpenTelemetry Node SDK line that brings `@opentelemetry/propagator-jaeger` 2.9.0+.

## Why

- `logfire/evals` accepts YAML through `Dataset.fromText()` and `fromFile()`; `js-yaml` 4.2.0 permits attacker-controlled quadratic merge work.
- `@pydantic/logfire-node` accepts SDK Node 0.219.0, which installs Jaeger 2.8.0 and can crash on malformed trace headers when Jaeger is selected.
- A lock-only update would leave published floors permissive, allowing consumers to keep resolving vulnerable versions.

## Success Criteria

- [x] The catalog and every applicable override require `js-yaml >=4.3.0`, and
      the lockfile contains no `js-yaml` version below 4.3.0.
- [x] The `@opentelemetry/sdk-node` catalog range starts at 0.220.0, and the
      resolved dependency graph contains no
      `@opentelemetry/propagator-jaeger` version below 2.9.0.
- [x] A committed machine-failing graph check enforces all three safe floors in
      CI; `pnpm why` remains diagnostic output only.
- [x] A deterministic test through `Dataset.fromText(..., { format: 'yaml' })`
      proves that YAML exceeding the patched merge-key ceiling is rejected.
- [x] Existing YAML/JSON dataset round trips and Node SDK configuration tests
      remain green.
- [x] Patch changesets describe the consumer-visible security floors for
      `logfire` and `@pydantic/logfire-node`.
- [x] Focused package validation and the full repository check pass.

## Assurance

- **Profile**: Standard
- **Rationale**: Bounded, reversible version-floor changes cover one public parser and one conditional runtime path with established tests. No authentication, persistence, schema, deployment, or other Deep trigger changes; Standard is retained because published floors and merge-heavy YAML behavior change.

## Consumer Contract

### Consumer and Public Boundary

- **Consumer(s)**: `logfire/evals` YAML integrators and Node operators installing `@pydantic/logfire-node` with declared OpenTelemetry peers.
- **Public or supported boundary**: `Dataset.fromText()`/`fromFile()`, published `logfire` dependencies, and the Node package peer contract.
- **Entry point and prerequisites**: Node 24/pnpm 11.5.2; import `Dataset` or install the Node package with compatible peers.
- **Current observable behavior**: normal YAML works, merge chains amplify quadratically, and accepted SDK Node 0.219.0 resolves Jaeger 2.8.0.
- **Observable promise**: normal YAML remains compatible, excessive merges are rejected, and the supported Node graph excludes vulnerable Jaeger.
- **Must remain compatible with**: documented YAML/JSON, Node/Bun/Deno filesystem helpers, default W3C propagation, Node 24, and `<0.300.0`.
- **Not claimed**: YAML above 10,000 merged keys, a Logfire Jaeger API, dismissed alerts, or downstream lock updates without consumer action.

### Acceptance Scenarios

| ID     | Given                                                                                                                                                                  | When                                                                                                         | Then                                                                                                                                         | Exact exercise and prerequisites                                                                                                                                                                                                                                                                                                      | Required evidence                                                                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CX-1` | A consumer has a Python-compatible YAML dataset using supported fields and ordinary mappings                                                                           | The consumer loads it through `Dataset.fromText(..., { format: 'yaml' })`, serializes it, and loads it again | Dataset name, cases, expected outputs, and evaluator configuration are preserved                                                             | Run `vp run logfire#test -- -t "round-trips dataset.*YAML"` and the public self-reference smoke command from `packages/logfire-api`: `node --input-type=module -e "import { Dataset } from 'logfire/evals'; const d=Dataset.fromText('name: x\\ncases: []\\n',{format:'yaml'}); if(d.name!=='x')process.exit(1)"` after build/install | DIRECT REQUIRED — exercises the documented package export and existing public dataset journey                                                             |
| `CX-2` | A YAML dataset contains an alias/merge chain whose cumulative merged keys exceed 10,000                                                                                | The consumer passes the generated document to `Dataset.fromText(..., { format: 'yaml' })`                    | Parsing terminates by throwing an error containing `merge keys exceeded maxTotalMergeKeys (10000)` instead of completing the amplified merge | Add and run a focused Vitest case in `packages/logfire-api/src/evals/__test__/serialization.test.ts`; generate at least 150 chained mappings so the cumulative key count deterministically exceeds 10,000, without a timing assertion                                                                                                 | DIRECT REQUIRED — invokes the public dataset parser and observes the patched failure contract                                                             |
| `CX-3` | A Node integrator uses SDK Node at the new minimum 0.220.0 while Logfire's other public OpenTelemetry peers remain at their currently allowed 0.219/2.8 minimum family | The minimum-mix graph is installed and the Node package test/typecheck harness configures `NodeSDK`          | Jaeger resolves to 2.9.0 or newer, Logfire typechecks and starts, and default W3C configuration remains green                                | Keep the validation lock on SDK Node 0.220.0 while retaining the other direct peer resolutions at their existing minimums; run the machine graph check plus `vp run @pydantic/logfire-node#typecheck` and `#test`                                                                                                                     | PROXY ACCEPTABLE — the unpublished package cannot be registry-installed, but the workspace executes the exact lowest newly allowed mixed peer combination |

## Research Summary

### Vetted Repository Findings

- `packages/logfire-api/package.json:103-107` — `js-yaml` is a production dependency despite alert 256's development label. — **PRP impact**: release a runtime consumer fix.
- `packages/logfire-api/src/evals/Dataset.ts:85-104` and `serialization/yaml.ts:6-10` — public YAML input reaches `js-yaml.load()`. — **PRP impact**: test `Dataset.fromText()`, not the dependency directly.
- `packages/logfire-api/src/evals/__test__/serialization.test.ts:175-245,368-485` — current tests cover YAML/JSON and filesystem round trips. — **PRP impact**: add one security case while retaining compatibility coverage.
- `pnpm-workspace.yaml:10-20,30-65` — the override/catalog retain YAML 4.2.0 and SDK Node 0.219.0 floors. — **PRP impact**: update all three constraints before lock regeneration.
- `pnpm-lock.yaml:96-128,431-439,1676,1734,4891-4975` — the graph resolves YAML 4.2.0, SDK Node 0.219.0, and Jaeger 2.8.0. — **PRP impact**: make graph inspection a gate.
- `packages/logfire-node/package.json:88-112` — SDK Node is both a development and published peer dependency. — **PRP impact**: the catalog floor controls local and consumer contracts.
- `packages/logfire-node/src/sdk.ts:356-404` and `logfireConfig.ts:238-250` — default propagation is explicit W3C. — **PRP impact**: preserve implementation behavior; update the optional vulnerable line.
- `packages/logfire-api/README.md:267-288` — YAML persistence is documented for Node, Bun, and Deno. — **PRP impact**: retain normal YAML behavior in `CX-1`.
- `AGENTS.md` and `package.json:5-17` — package-visible changes need changesets, focused validation, and the full check. — **PRP impact**: include all three.
- GitHub on 2026-07-22 — alerts 258 and 256 are the only open alerts after evidence-backed dismissals. — **PRP impact**: exclude dismissed tooling/example alerts.

### External Constraints

- `js-yaml` 4.2.0 — [GHSA-52cp-r559-cp3m](https://github.com/advisories/GHSA-52cp-r559-cp3m) affects `<4.3.0`; [loader.js 4.3.0](https://github.com/nodeca/js-yaml/blob/4.3.0/lib/loader.js#L384-L385) throws `merge keys exceeded maxTotalMergeKeys (10000)` above the default ceiling.
- Jaeger 2.8.0 — [GHSA-45rx-2jwx-cxfr](https://github.com/advisories/GHSA-45rx-2jwx-cxfr) affects `<2.9.0`; 2.9.0 ignores malformed percent encoding.
- OpenTelemetry [v2.9.0's SDK Node manifest](https://github.com/open-telemetry/opentelemetry-js/blob/v2.9.0/experimental/packages/opentelemetry-sdk-node/package.json) publishes SDK Node 0.220.0 with Jaeger 2.9.0.

### Settled Decisions and Rejected Alternatives

- **Decision**: raise YAML catalog and Changesets override floors to 4.3.0; a lock-only update would leave downstream and tooling exposure.
- **Decision**: raise SDK Node's public floor to 0.220.0; a root override would not protect consumers.
- **Decision**: resolve SDK Node exactly 0.220.0 in the validation lock while retaining the other direct peers at existing minima; this exercises the lowest newly supported mixed graph rather than only the latest release.
- **Decision**: retain `<0.300.0` and existing W3C behavior; do not add a Jaeger API or propagation changes.
- **Decision**: assert the 10,000-key error, not elapsed time, and issue patch changesets for both affected packages.
- **Decision**: add a CI-wired Node graph assertion; `pnpm why` is diagnostic and cannot enforce floors by exit status.

### Spike Evidence

- None needed — official manifests establish the minimums and YAML's exact deterministic error.

### Validation Baseline

| Command                                                                     | Status                        | Observed or expected result                               |
| --------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------- |
| `vp run logfire#test`                                                       | Verified                      | 32 files, 453 tests passed                                |
| `vp run @pydantic/logfire-node#test`                                        | Verified                      | 9 files, 92 tests passed                                  |
| Both focused typechecks and the public `logfire/evals` self-reference smoke | Verified                      | exited 0; smoke printed `x`                               |
| `pnpm why -r js-yaml`                                                       | Verified, vulnerable baseline | resolves 4.2.0, including published `logfire` runtime use |
| `pnpm why -r @opentelemetry/propagator-jaeger`                              | Verified, vulnerable baseline | resolves 2.8.0 through SDK Node 0.219.0                   |
| `pnpm run check`                                                            | Discovered but not run        | full integrated final gate                                |

### Research Coverage

- **Depth**: Standard
- **Inspected**: advisories, catalog/overrides/lockfile, manifests, public YAML path/docs/tests, NodeSDK integration/tests, release conventions, and patched manifests.
- **Not inspected**: dismissed tooling/example alerts, unrelated runtimes, registry publication, and downstream lockfiles.
- **Research confidence**: HIGH — versions, public reachability, ownership, deterministic failure behavior, and gates are directly evidenced.

## Execution Contract

- **Planned at commit**: `0dfe847`
- **Planning baseline**: clean `main` worktree before this PRP was created;
  preserve any changes that appear after planning.

### Expected Changes

- `pnpm-workspace.yaml` — raise `js-yaml` catalog/override floors and the
  `@opentelemetry/sdk-node` catalog floor.
- `pnpm-lock.yaml` — regenerate the affected dependency graph with patched
  versions and integrity records.
- `scripts/assert-security-dependency-versions.mjs`, its test, and `package.json`
  — add a machine-failing CI gate for declared and resolved floors.
- `packages/logfire-api/src/evals/__test__/serialization.test.ts` — add the
  deterministic public-parser merge-key regression.
- `.changeset/<security-fix>.md` — patch release notes for `logfire` and
  `@pydantic/logfire-node`.

### Explicitly Out of Scope

- Source-level changes to `Dataset`, YAML schemas, propagation selection,
  `NodeSDK` construction, exporters, or auto-instrumentations.
- Upgrading or reopening dismissed alerts for Sharp, Vitest, body-parser,
  protobufjs, Undici, or ws.
- Broad dependency modernization beyond resolver changes required to produce a
  compatible SDK Node 0.220+/Jaeger 2.9+ graph.
- Publishing packages or manually closing Dependabot alerts before GitHub
  processes the merged dependency graph.

### Scope Expansion Rule

Additional files may change when the package manager must align a directly
coupled OpenTelemetry release family to satisfy strict peers, tests, or
typechecking. Record each such file/version and why it is required. Pause for
user direction if remediation requires a public API change, removal of a
supported runtime, a major dependency upgrade, or unrelated package releases.

### Pause and Reassess If

- `js-yaml` 4.3.0 rejects ordinary documented dataset YAML rather than only
  over-limit merge input.
- SDK Node 0.220+ cannot typecheck or start with the repository's supported
  OpenTelemetry peer ranges without broadening the public compatibility change
  beyond the coupled 2.9/0.220 release family.
- Regenerating the lockfile introduces unresolved high/critical advisories into
  a published package path.
- The package manager requires a major version or a change to the `<0.300.0`
  OpenTelemetry upper bound.
- Implementation overlaps new user changes in the expected files.

## Context

- `pnpm-workspace.yaml` and `pnpm-lock.yaml` own published floors and resolver evidence; update the YAML override as well as the catalog.
- `scripts/assert-security-dependency-versions.mjs` and `package.json` own the durable machine-failing graph gate; `pnpm why` is diagnostic only.
- `packages/logfire-api/src/evals/Dataset.ts`, `serialization/yaml.ts`, and `__test__/serialization.test.ts` own the public parser and regression surface.
- `packages/logfire-node/package.json` and `src/sdk.ts` own the SDK Node peer contract and unchanged W3C integration.
- `.changeset/README.md` defines release-note format.
- SDK Node 0.220.0 corresponds to stable OpenTelemetry 2.9.0; accept only explained alignment churn, and do not disable YAML's 10,000-key protection.

## Implementation Blueprint

### Tasks

```yaml
Task 1: Raise consumer security floors and regenerate the graph
  MODIFY pnpm-workspace.yaml:
    - Change the js-yaml catalog entry from ^4.2.0 to ^4.3.0.
    - Change @changesets/parse>js-yaml from 4.2.0 to 4.3.0.
    - Change @opentelemetry/sdk-node from >=0.219.0 <0.300.0 to >=0.220.0 <0.300.0.
    - Do not change the OpenTelemetry upper bound or unrelated overrides.
  MODIFY pnpm-lock.yaml:
    - Regenerate with the repository-pinned Node/pnpm versions.
    - Resolve SDK Node exactly 0.220.0 for minimum-contract validation while leaving other direct OpenTelemetry peers at their current 0.219/2.8 minima.
    - Retain only resolver churn required by the three constraint changes and coupled OpenTelemetry compatibility.
    - Confirm every js-yaml entry is >=4.3.0 and every propagator-jaeger entry is >=2.9.0.
  PATTERN: pnpm-workspace.yaml:10-28 and 30-65
  ENABLES: CX-1, CX-2, CX-3
  VERIFY:
    - COMMAND: vp install && pnpm why -r js-yaml && pnpm why -r @opentelemetry/sdk-node && pnpm why -r @opentelemetry/propagator-jaeger
    - EXPECTED: install exits 0; diagnostic output shows js-yaml >=4.3.0, SDK Node exactly 0.220.0, Jaeger >=2.9.0, and existing direct peers at their current minima
    - FAILURE-LOCAL: inspect `git diff -- pnpm-workspace.yaml pnpm-lock.yaml` and rerun the individual `pnpm why -r <package>` command

Task 2: Lock the YAML denial-of-service behavior at the public boundary
  MODIFY packages/logfire-api/src/evals/__test__/serialization.test.ts:
    - Add a helper or local fixture that creates at least 150 mappings, each merging the previous anchor and adding one key.
    - Pass the generated YAML through Dataset.fromText with format yaml.
    - Assert the exact stable error substring `merge keys exceeded maxTotalMergeKeys (10000)`.
    - Keep existing normal YAML and JSON round-trip assertions unchanged.
    - Do not add elapsed-time assertions or call js-yaml directly.
  PATTERN: packages/logfire-api/src/evals/__test__/serialization.test.ts:175-245 and 458-485
  ENABLES: CX-1, CX-2
  VERIFY:
    - COMMAND: vp run logfire#test -- -t "merge keys|round-trips dataset.*YAML|parseYaml reads"
    - EXPECTED: the security rejection and normal compatibility tests pass deterministically

Task 3: Add a deterministic dependency-floor gate
  CREATE scripts/assert-security-dependency-versions.mjs:
    - Read pnpm-workspace.yaml and pnpm-lock.yaml without adding a production dependency.
    - Accept optional workspace/lock paths so isolated fixtures can exercise failures; default to the live repository files.
    - Fail nonzero unless YAML catalog and override floors are >=4.3.0, SDK Node's catalog floor is >=0.220.0, and every locked js-yaml/SDK Node/Jaeger package key satisfies its safe floor.
    - Print offending package/version entries on failure and a concise version summary on success.
  CREATE scripts/assert-security-dependency-versions.test.mjs:
    - Invoke the assertion against the live graph, then temporary copied fixtures with each checked dependency made unsafe in turn.
    - Assert nonzero status and the exact offending package/version; remove fixture scratch in finally without modifying live files.
  MODIFY package.json:
    - Add `test:security-dependencies` for the test driver and invoke it from root `check` before package tests.
  ENABLES: CX-2, CX-3
  VERIFY:
    - COMMAND: pnpm run test:security-dependencies
    - EXPECTED: live graph passes; every isolated unsafe fixture exits nonzero and identifies its offending package/version; all scratch is removed

Task 4: Record the package-visible remediation
  CREATE .changeset/<security-fix>.md:
    - Select patch releases for `logfire` and `@pydantic/logfire-node`.
    - Explain that logfire now requires patched js-yaml merge-key limits.
    - Explain that logfire-node now requires an SDK Node line containing the fixed Jaeger propagator.
    - State the relevant minimum versions without overstating exposure under default W3C propagation.
  PATTERN: .changeset/README.md and existing repository changeset format
  ENABLES: CX-1, CX-2, CX-3
  VERIFY:
    - COMMAND: pnpm exec changeset status
    - EXPECTED: exactly the intended patch releases are attributable to the new changeset; no unrelated public package is selected by this file

Task 5: Run focused and integrated compatibility gates
  VERIFY repository and package boundaries:
    - Run both package test and typecheck targets after lock regeneration.
    - Exercise the documented logfire/evals self-reference import.
    - Run the full workspace check last.
    - Review the final diff for unexplained lockfile or package-scope expansion.
  ENABLES: CX-1, CX-2, CX-3
  VERIFY:
    - COMMAND: pnpm run test:security-dependencies && vp run logfire#test && vp run logfire#typecheck && vp run @pydantic/logfire-node#test && vp run @pydantic/logfire-node#typecheck && pnpm run check
    - EXPECTED: all commands exit 0; focused test counts are at least the 453/92-test baseline plus the new YAML regression
    - FAILURE-LOCAL: rerun the failing package's `#test` or `#typecheck`; use the focused Task 2 test selector for YAML failures and `pnpm why -r` for graph failures
```

## Validation

Integrated procedure: run the following block from the repository root in order; the final `pnpm run check` is the full-workspace terminal gate.

```bash
vp install
pnpm why -r js-yaml
pnpm why -r @opentelemetry/sdk-node
pnpm why -r @opentelemetry/propagator-jaeger
pnpm run test:security-dependencies

vp run logfire#test
vp run logfire#typecheck
vp run @pydantic/logfire-node#test
vp run @pydantic/logfire-node#typecheck

cd packages/logfire-api && node --input-type=module -e "import { Dataset } from 'logfire/evals'; const d=Dataset.fromText('name: x\ncases: []\n',{format:'yaml'}); if(d.name!=='x')process.exit(1)" && cd ../..

pnpm exec changeset status
pnpm run check
git diff --check
```

After merge, GitHub's dependency graph should automatically mark alerts 256
and 258 fixed. That external asynchronous state is a post-merge observation,
not a pre-merge implementation gate.

## Execution Notes

- **Scope expansion**: guarded `read-yaml-file@2.1.0>js-yaml`, the final 4.2.0 path.
- **Resolver procedure**: temporary pnpm policy/SDK overrides bypassed Vite+'s `minimumReleaseAge` `Invalid time value`; both were removed before a successful frozen install.
- **Coupled graph change**: SDK Node internals moved to 0.220.0/2.9.0; direct catalog peers remain at 0.219.0/2.8.0 minima. Lock regeneration also normalized Vite+'s `yaml` peer metadata from `^2.4.2` to its unchanged 2.8.2 resolution.
- **Validation result**: graph/fixtures, API 454/454, Node 92/92, typechecks, public import, changesets, and full `pnpm run check` passed.
- **Unresolved implementation risks**: none.

## Unknowns & Risks

- Resolver churn may align additional OpenTelemetry packages to the 2.9/0.220
  family. This is acceptable only when required for strict peers or compilation
  and must be named in execution notes; unrelated modernization is excluded.
- Consumers with frozen lockfiles must update their dependency resolution to
  receive the patched versions. The changesets should make that requirement
  visible, but the repository cannot rewrite downstream locks.
- Legitimate YAML exceeding 10,000 cumulative merged keys will now throw. This
  is the upstream security contract and is explicitly excluded from supported
  compatibility rather than silently disabling the protection.
- GitHub alert closure is asynchronous after merge; local version/graph gates
  are the deterministic pre-merge evidence.

**Confidence: 9/10** for one-pass implementation success.

## Verification Record

- **Date**: 2026-07-22
- **Verifier**: fresh-context, read-only Standard PRP verifier
- **Baseline/HEAD**: `0dfe847fe0f610c31f4fee703f275f75222283b4`
- **Status**: `VERIFIED`

### Consumer Acceptance

| Scenario | Grade               | Evidence                                                                                                       | Limitations                                                                                               |
| -------- | ------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `CX-1`   | `DIRECTLY VERIFIED` | Focused YAML round trip passed; public `logfire/evals` import parsed YAML and returned dataset name `x`        | None material                                                                                             |
| `CX-2`   | `DIRECTLY VERIFIED` | Public 150-link merge chain threw `merge keys exceeded maxTotalMergeKeys (10000)`; committed regression passed | None material                                                                                             |
| `CX-3`   | `PROXY VERIFIED`    | Guard/fixtures passed; lock contains SDK Node 0.220.0 and Jaeger 2.9.0; Node typecheck and 92/92 tests passed  | Explicitly accepted unpublished-workspace proxy; no registry install or malformed-Jaeger runtime exercise |

### Compliance and Engineering Review

- All success criteria and blueprint tasks are implemented; exclusions and the
  `<0.300.0` upper bound are preserved.
- The verifier initially found an unsafe-disjunction false negative in the
  declaration guard. Exact/caret/bounded grammar validation plus a regression
  fixture resolved it; targeted independent follow-up confirmed exit 1.
- The focused selector, resolved-version summary, and Vite+ `yaml` lock metadata
  note were corrected. No unexplained source or dependency scope remains.
- No unresolved gaps or deviations block readiness. Frozen downstream locks and
  post-merge GitHub alert closure remain consumer/external follow-up conditions.

### Evidence

| Gate                                        | Result                                                |
| ------------------------------------------- | ----------------------------------------------------- |
| PRP validator and `git diff --check`        | PASS                                                  |
| Security graph guard plus 8 unsafe fixtures | PASS; `js-yaml` 4.3.0, SDK Node 0.220.0, Jaeger 2.9.0 |
| Exact Task 2 focused selector               | PASS; 3/3 selected tests                              |
| API tests/typecheck and public import       | PASS; 454/454, typecheck, import returned `x`         |
| Node tests/typecheck                        | PASS; 92/92 and typecheck                             |
| Changeset status and frozen install         | PASS                                                  |
| Full `pnpm run check` after verifier fixes  | PASS                                                  |
