# Browser Release Integrity and Token Safety

## Goal

Make the browser RUM stable-release plan deterministic and safe to operate:
Changesets must produce exactly browser `0.17.0`, session replay `0.1.0`, and
the expected private prerelease normalization without null artifacts; the
stable browser changelog must retain every shipped feature; and the npm token
helper must transfer its generated secret only over standard input, never a
process argument.

## Why

- A versionless private Next.js example currently makes Changesets 2.30.0
  report `newVersion: null`, which can contaminate a generated Version Packages
  change.
- The stable browser changelog generated from the current inventory omits the
  central opt-in lazy `autoInstrumentations` feature even though the alpha note
  documents it.
- `scripts/create-npm-token.sh` passes a live npm credential through `gh
secret set --body`, exposing it to local process inspection.
- R9 needs a repeatable, no-publish release-plan gate that inspects generated
  artifacts before any irreversible merge or registry operation.

## Success Criteria

- [x] `examples/nextjs/package.json` has the explicit private-package version
      `0.0.0`; Changesets status no longer reports that package or any null
      version.
- [x] The current exit-mode Changeset inventory reports exactly browser
      `0.17.0`, replay `0.1.0`, and private
      `@pydantic/nextjs-client-side-instrumentation` `0.1.16` as non-`none`
      releases, with no other public package release.
- [x] A browser-only minor Changeset restores the established stable
      `autoInstrumentations` release note without adding browser-only prose to
      replay's changelog or changing the intended public versions.
- [x] A disposable local verifier runs the installed Changesets 2.30.0 status
      and version operations, proves the exact allowed manifest/changelog
      artifacts, consumes exit metadata only in scratch, rejects null or
      unrelated version changes, preserves the live HEAD/index/worktree
      byte-for-byte, and never publishes.
- [x] The npm token helper invokes `gh secret set` without `--body` or the token
      in argv, writes the exact token to stdin without a trailing newline, and
      removes its temporary token directory on both success and failure.
- [x] A fake-command process test exercises the real helper with a sentinel
      credential, exact argv/stdin capture, and no GitHub, npm, or registry
      access.
- [x] The review-owned deterministic tests use exact assertions only for stable
      values, prove buffer/interval uploads through observable delivery, and
      retain partial matching for implementation-owned objects.
- [x] Parent roadmap scenario `CX-9` is directly reproducible, while publishing,
      Version Packages PR merge, npm dist-tag work, and GitHub release creation
      remain deferred to R9.

## Assurance

- **Profile**: Deep
- **Rationale**: R8 sits on two release-critical boundaries. Incorrect
  Changesets metadata can create or publish unintended versions, and incorrect
  token transport can disclose an npm credential through process arguments.
  The generated-artifact path also consumes prerelease state and twelve
  Changesets, so validation must occur only in a disposable clone. Research
  covered the complete R8 roadmap/review contract, installed Changesets 2.30.0
  source and empirical behavior, all live Changesets/manifests/changelogs, the
  protected-branch release workflow, the token helper, and every test named by
  the deterministic-assertion review. A fresh-context cold review is required
  before R8 may be marked `READY`.

## Roadmap Context

- **Parent roadmap**: `plans/roadmaps/001-browser-rum-release-remediation.md`
- **Roadmap step**: `R8` — Reconcile Changesets and release tooling.
- **Satisfied dependencies**: R1-R7 are verified. Their package-visible changes
  are represented by the live exit-mode Changeset inventory at planning
  baseline `c628404ede63647fa0630e7f2f0daa7dc372cdb4`, including the verified
  but uncommitted R7 proxy/example Changeset.
- **Inherited decisions and invariants**:
  - preserve browser `0.17.0` and replay `0.1.0` as the only public releases;
  - preserve the normal protected-main Changesets action and two-stage feature
    PR -> Version Packages PR -> publish flow;
  - preserve all R1-R7 public behavior and release-note ownership; R8 changes
    release metadata, maintainer tooling, and tests, not SDK runtime behavior;
  - keep the direct browser token path an advanced escape hatch and do not use a
    real npm or Logfire credential during implementation or validation;
  - do not publish, merge a Version Packages PR, create tags/releases, alter npm
    dist-tags, or modify unrelated package versions.
- **Contract produced for later steps**: valid manifests, complete stable
  Changesets/changelogs, a secret-safe npm token helper, and an executable
  no-publish `CX-9` gate for R9.

## Consumer Contract

### Consumer and Public Boundary

- **Consumer(s)**: release maintainers reviewing the stable release plan, CI
  enforcing it, and R9's integration/publish operator.
- **Public or supported boundary**: `.changeset` status/version output, package
  manifest versions, generated stable changelog sections,
  `scripts/create-npm-token.sh`, and the protected-main release workflow.
- **Entry point and prerequisites**: Node 24, pnpm 11.5.2, installed
  `@changesets/cli 2.30.0`, the complete R1-R8 working tree in exit mode, and
  local git metadata. Token validation uses fake `gh`, `npm`, and `script`
  executables plus a sentinel value; it requires no authentication or network.
- **Current observable behavior**: Changesets status reports the versionless
  private Next.js example with `newVersion: null`; a disposable version run
  omits `autoInstrumentations` from the new stable browser section; and the npm
  helper includes the generated token in `gh` argv.
- **Observable promise**: a release operator receives one exact, valid stable
  plan and can verify its generated artifacts without touching the live tree or
  publishing; the token helper presents the generated token only on stdin and
  cleans up temporary material on every exit.
- **Must remain compatible with**: Changesets 2.30.0 exit-mode semantics,
  `.github/workflows/main.yml`, `pnpm run release`, the current npm-token helper
  prompts and repository/environment targets, and the R1-R7 package-visible
  feature inventory.
- **Not claimed**: successful npm publication, registry/dist-tag correctness,
  GitHub secret mutation during tests, Version Packages PR approval, unrelated
  package release cleanup, or any browser/replay runtime API change.

### Acceptance Scenarios

| ID      | Given                                                                                                                                        | When                                                                                             | Then                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Exact exercise and prerequisites                                                                                                                                                                                                                                                                                                                                                                                               | Required evidence                                                                                                    |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `CX-9`  | All R1-R8 Changesets are present, prerelease state is `exit`, the private Next.js manifest is normalized, and installed Changesets is 2.30.0 | A release operator runs status and `changeset version` through the committed disposable verifier | The non-`none` plan is exactly browser `0.17.0`, replay `0.1.0`, and private client example `0.1.16`; the version operation changes only the allowed manifests/changelogs, leaves the private Next.js example at `0.0.0` with no changelog, removes prerelease/Changeset inputs only in scratch, emits complete stable notes including `autoInstrumentations`, contains no null artifact, preserves source HEAD/index/status and every dirty file byte, and never invokes publish | Run `node scripts/verify-browser-release-plan.mjs` from the live working tree after install. The verifier first pins CLI/assemble/apply versions, captures source git state plus complete path/type/content hashes, creates a dedicated local clone, overlays tracked/untracked live files, runs resolved-CLI status/version, compares the full path union, and removes scratch plus verifies source preservation in `finally` | DIRECT REQUIRED — exercises the actual pinned release CLI and generated consumer artifacts without external mutation |
| `CX-9F` | The real npm-token helper runs with fake command executables and a generated sentinel token                                                  | Fake `gh secret set` succeeds, then rejects with exit 23 in a second isolated run                | In both runs the exact secret-setting argv contains no token and no `--body`, stdin equals the sentinel byte-for-byte, stdout/stderr do not reveal it, no real command is reached, and both the helper token workdir and outer secret-bearing case root are removed; the failure run exits 23                                                                                                                                                                                     | Run `node scripts/create-npm-token.test.mjs`; its fake `mktemp`, `script`, `npm`, and `gh` binaries capture the real helper boundary in dedicated temporary directories                                                                                                                                                                                                                                                        | DIRECT REQUIRED — directly inspects child-process argv/stdin and cleanup for success and failure                     |

## Research Summary

### Vetted Repository Findings

- `plans/roadmaps/001-browser-rum-release-remediation.md:48-59,321-335` — R8
  owns `CX-9`, exact public versions, B6/B12, changelog coverage,
  deterministic-test cleanup, and disposable status/version plus argv evidence.
  — **PRP impact**: all are completion gates; publication remains R9.
- `reports/pr-161-combined-review.md:108-117,184-192` — the versionless private
  example reproduces a null release and `--body` exposes the npm token in argv.
  — **PRP impact**: add `0.0.0`, transfer the token over stdin, and retain the
  cleanup trap.
- `reports/pr-161-combined-review.md:333-360,374-387` — stable release notes
  must restore `autoInstrumentations`; named deterministic assertions should be
  exact; prior isolated versioning establishes the intended versions and
  consumption semantics. — **PRP impact**: release prose and bounded test
  strengthening are first-class R8 scope.
- `examples/nextjs/package.json:1-4` — the private package has no version. —
  **PRP impact**: insert exactly `"version": "0.0.0"` beside its name; do not
  enable private-package publication.
- `.changeset/config.json:1-13` and `.changeset/pre.json:1-27` — the repository
  is in exit mode with default private-package handling and the alpha feature
  inventory. — **PRP impact**: do not alter Changesets private-package config or
  prerelease state in the live tree.
- `.changeset/*.md` — the live inventory selects browser in nine files and
  replay in six; restoring browser-only `browser-rum-lifecycle` makes the final
  inventory twelve files and browser's selector count ten. — **PRP impact**:
  assert exact IDs/selectors/status before generating artifacts.
- `packages/logfire-browser/CHANGELOG.md:3-8` — the established alpha sentence
  names deferred factories, opt-in lazy `autoInstrumentations`, provider-owned
  Web Vitals spans, explicit page URLs, and replay correlation. — **PRP
  impact**: restore that exact sentence as a browser-only minor Changeset.
- `scripts/create-npm-token.sh:12-16,31-63` — the helper already isolates token
  output under `mktemp` with an EXIT trap and extracts it without printing it,
  but passes it as `--body "$TOKEN"`. — **PRP impact**: retain acquisition,
  parsing, target repo/environment, and trap; change only the final transport.
- Local `gh secret set --help` for installed gh 2.95.0 states that omitting
  `--body` reads the secret from stdin. — **PRP impact**: use
  `printf '%s' "$TOKEN" | gh secret set ... >/dev/null`; do not add a trailing
  newline or expose gh's output through the helper.
- `.github/workflows/main.yml:38-71` and `package.json:6-17` — the protected-main
  workflow publishes only through `changesets/action`, while its current test
  step bypasses root-only script tests. — **PRP impact**: add the durable
  fake-token test to root `check` and the build job without changing the release
  action; keep the exact-version simulator operator-invoked.
- `packages/logfire-browser/src/BrowserSessionSpanProcessor.test.ts:147-221`,
  `webVitals.test.ts:195-216,309-371`, `index.test.ts:909-1017,1180-1225`, and
  `sessionReplay.test.ts:272-336` contain the stable partial/diagnostic
  assertions identified by review. — **PRP impact**: exact-match stable
  projections/strings only; retain broad attribution/function-object partials.
- `packages/logfire-session-replay/src/recorder.test.ts:50-88`,
  `transport.test.ts:95-148`, `index.test.ts:286-293`, and
  `capture.test.ts:15-55` contain the sampling, threshold, interval, and
  truncation assertions identified by review. — **PRP impact**: exercise
  observable uploads and exact deterministic payloads.

### External Constraints

- Installed `@changesets/cli 2.30.0` with
  `@changesets/assemble-release-plan 6.0.9` and
  `@changesets/apply-release-plan 7.1.0` is the executable contract. Installed
  source confirms exit mode does not filter current Changesets whose IDs occur
  in `pre.json`, removes `pre.json` on version, and consumes non-skipped
  Changesets. Root `package.json` permits `@changesets/cli ^2.27.12`, so the
  verifier must resolve and assert all three exact installed versions before it
  runs; no web documentation or newer CLI behavior is assumed.
- Installed gh 2.95.0 reads `gh secret set` content from stdin when `--body` is
  absent. Validation substitutes a fake executable and never contacts GitHub.

### Settled Decisions and Rejected Alternatives

- **Decision**: add `version: 0.0.0` to the private Next.js example while
  leaving Changesets private-package configuration unchanged. — **Rationale**:
  the empirical status/version spike removes the null entry and leaves the
  package at `0.0.0` with no changelog. — **Rejected**: expecting `0.0.1`,
  ignoring/removing the generated artifact later, or enabling private releases.
- **Decision**: restore `.changeset/browser-rum-lifecycle.md` as browser-only
  minor using the exact existing alpha sentence. — **Rationale**: this preserves
  the stable feature note in the correct package; exit mode consumes the reused
  ID. — **Rejected**: adding browser-only wording to the shared browser/replay
  lifecycle Changeset or editing the changelog directly.
- **Decision**: add Node-based release and token verifiers with only built-in
  modules and unconditional scratch cleanup. Wire only the version-independent
  token test through root `check` and the existing CI build job; expose the
  hard-coded browser RUM release-plan verifier as an explicit R8/R9 operator
  command. — **Rejected**: a prose-only recipe, mutation of the live
  `.changeset` tree, real credentials, registry/network access, a production
  dependency, or permanently gating future releases on versions `0.17.0` and
  `0.1.0`.
- **Decision**: fail the release-plan verifier before scratch creation unless
  resolved packages are exactly CLI 2.30.0, assemble-release-plan 6.0.9, and
  apply-release-plan 7.1.0, then invoke the resolved CLI bin with the current
  Node executable. — **Rejected**: trusting the root caret range or whichever
  `changeset` happens to be first on `PATH` while claiming 2.30.0 evidence.
- **Decision**: capture the fake `gh` process's actual argv and stdin rather
  than race `ps`. — **Rationale**: exact capture is deterministic and directly
  proves the supported boundary. A token generated only after the helper starts
  must also be absent from captured stdout/stderr.
- **Decision**: constrain assertion cleanup to review-named stable values and
  exact stable projections. — **Rejected**: blanket replacement of
  `toMatchObject`/`toContain`, deep equality on functions/regexes/Web Vitals
  attribution, or runtime refactoring to satisfy tests.

### Spike Evidence

- `plans/research/030-browser-release-integrity/spike-01-changesets-exit-artifacts.md`
  — **Question**: exact exit-mode status/version artifacts after normalizing the
  private Next.js manifest. — **Result/decision**: browser `0.17.0`, replay
  `0.1.0`, private client `0.1.16`, Next.js unchanged `0.0.0`, no null or
  Next.js changelog, consumed exit metadata, and a missing stable
  `autoInstrumentations` note that must be restored. — **Limits**: no publish,
  registry, future Version Packages PR, or commit-hash ordering was tested.

### Validation Baseline

| Command                                                            | Status                      | Observed or expected result                                                                                                              |
| ------------------------------------------------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `git rev-parse HEAD && git status --short`                         | Verified                    | Exact planning commit `c628404...`; verified R7 files and planning records are intentionally unstaged/uncommitted and must be preserved. |
| `pnpm exec changeset --version`                                    | Verified                    | `2.30.0`.                                                                                                                                |
| `pnpm exec changeset status --output /tmp/status.json`             | Baseline failing            | Intended browser/replay/private-client plan plus `@pydantic/logfire-nextjs-example` patch with `newVersion: null`.                       |
| Disposable status/version spike with scratch-only `version: 0.0.0` | Verified                    | Exact versions/artifacts recorded in Spike 01; no live file or external mutation.                                                        |
| `gh secret set --help`                                             | Verified                    | Omitting `--body` reads the secret from stdin.                                                                                           |
| `pnpm run check`                                                   | Verified before R8 drafting | Passed during R7 verification on 2026-07-13; not rerun after adding planning-only files.                                                 |

### Research Coverage

- **Depth**: Deep
- **Inspected**: complete parent roadmap and combined review; prior stable-release
  PRP; every current Changeset and prerelease/config file; relevant public and
  private manifests/changelogs; installed Changesets source; protected-main
  workflow and root scripts; token helper and gh CLI contract; all review-named
  browser/replay tests; disposable status/version output.
- **Not inspected**: npm registry state, GitHub secrets, a future Version
  Packages PR, R9 publication/tag cleanup, unrelated runtime packages, or
  downstream Platform code because they are outside R8 and would require
  external mutation or later authorization.
- **Research confidence**: HIGH — exact CLI behavior was reproduced locally,
  the reused Changeset-ID rule was confirmed in installed source, and both
  independent research lanes were vetted against live files. One lane's
  untested `0.0.1` expectation was rejected in favor of direct spike evidence.

## Execution Contract

- **Planned at commit**: `c628404`
- **Execution baseline**: clean commit `99f7285`. The verified R7 implementation,
  `plans/029-browser-proxy-example-safety.md`, the roadmap's R7 verification
  record, this PRP, and its spike record are committed. Capture exact source
  state before disposable verification and preserve it byte-for-byte.

### Expected Changes

- `examples/nextjs/package.json` — add explicit private version `0.0.0`.
- `.changeset/browser-rum-lifecycle.md` — restore the exact browser-only minor
  stable feature note.
- `scripts/create-npm-token.sh` — pipe the token to gh stdin without `--body`.
- `scripts/create-npm-token.test.mjs` — fake-command argv/stdin/leak/cleanup
  success and failure test.
  - `scripts/verify-browser-release-plan.mjs` — exact-version-pinned disposable
    Changesets status, version, full-tree artifact, source-preservation, and
    cleanup verifier.
- `package.json` — add a durable token-helper test command, include it in root
  `check`, and add a separate explicit browser RUM release-plan verifier command.
- `.github/workflows/main.yml` — run only the version-independent token-helper
  test in the existing build job; leave release/publish steps unchanged.
- `packages/logfire-browser/src/BrowserSessionSpanProcessor.test.ts` — exact
  stable session/page/replay attributes.
- `packages/logfire-browser/src/webVitals.test.ts` — exact observer options and
  tracer-selection arrays where stable.
- `packages/logfire-browser/src/index.test.ts` — exact instrumentation/Web
  Vitals registration projections without deep-matching functions.
- `packages/logfire-browser/src/sessionReplay.test.ts` — exact diagnostic text
  and error identity.
- `packages/logfire-session-replay/src/recorder.test.ts` — exact sampling config.
- `packages/logfire-session-replay/src/transport.test.ts` — exact headers and
  pre-shutdown threshold upload.
- `packages/logfire-session-replay/src/index.test.ts` — interval behavior via
  an observed replay upload.
- `packages/logfire-session-replay/src/capture.test.ts` — exact deterministic
  console payload serialization/truncation only.

### Explicitly Out of Scope

- SDK runtime/API/type behavior, replay wire format, proxy/example behavior,
  privacy defaults, or package dependency redesign.
- Running `changeset version` in the live tree, committing generated stable
  manifests/changelogs, or deleting live `.changeset/pre.json`/Changesets.
- Publishing, `pnpm run release`, npm login/token creation, real `gh secret
set`, Version Packages PR merge, tags/releases/dist-tags, or branch deletion.
- Modifying unrelated versions, Changesets private-package policy, the Python
  Logfire repository, downstream Platform code, or release-note commit hashes.

### Scope Expansion Rule

Additional files may change only when necessary to make the two local verifiers
portable in the existing Node 24/CI environment or to exact-match another
review-named deterministic value. Record the file and rationale. Pause for user
direction if expansion changes runtime/public API behavior, release versions,
workflow publication semantics, secret destinations, dependency policy, or
external state.

### Pause and Reassess If

- Status after the final twelve-file inventory differs from the exact three
  non-`none` releases in `CX-9`, or any other public package is proposed.
- Resolved Changesets component versions differ from CLI 2.30.0,
  assemble-release-plan 6.0.9, or apply-release-plan 7.1.0; do not silently
  re-baseline the expected plan to a newer install.
- Disposable versioning changes another manifest/changelog, produces a null,
  creates a Next.js changelog, omits a current Changeset summary, or does not
  consume exit metadata in scratch.
- Reusing `browser-rum-lifecycle` is filtered in actual final status despite the
  installed exit-mode source, or restoring it changes browser/replay versions.
- The token can appear in argv, output, an inherited environment value, or a
  surviving temp path after either fake success or fake failure.
- CI coverage would require changing the release job/action, granting new
  permissions, installing a new dependency, or contacting an external service.
- A deterministic assertion can be made exact only by changing production
  behavior or coupling to implementation-owned functions, regexes, timestamps,
  generated IDs, or attribution fields.

## Context

### Key Files

- `plans/roadmaps/001-browser-rum-release-remediation.md` — R8/CX-9 authority
  and R9 boundary.
- `plans/research/030-browser-release-integrity/spike-01-changesets-exit-artifacts.md`
  — empirical expected plan/artifacts.
- `.changeset/config.json`, `.changeset/pre.json`, `.changeset/*.md` — live
  exit-mode inputs; never mutate them with versioning in place.
- `packages/logfire-browser/CHANGELOG.md` — source of exact restored stable note.
- `examples/nextjs/package.json` — B6 manifest normalization point.
- `scripts/create-npm-token.sh` — B12 secret-transfer boundary.
- `.github/workflows/main.yml`, `package.json` — durable validation integration
  and protected-main release path.
- Browser/replay tests listed under Expected Changes — bounded deterministic
  cleanup; production source should remain untouched.

### External References

- None required. The PRP relies on installed Changesets/gh behavior and local
  empirical evidence rather than version-drifting web documentation.

### Gotchas

- `private: true` does not by itself prevent the exit-mode null defect when a
  manifest has no version. Adding `0.0.0` makes the package skipped correctly;
  it does not authorize a private release.
- In exit mode, current Changesets are not filtered by IDs already recorded in
  `pre.json`; restoring `browser-rum-lifecycle` is intentional. Do not rename it
  merely to avoid the prior ID.
- A current-tree simulation must include tracked edits and untracked R7/R8
  Changesets. A plain clone of `HEAD` omits them; the verifier must overlay
  `git ls-files --cached --others --exclude-standard` and account for deletions.
- Capture source HEAD, binary-safe staged index entries, binary-safe full
  porcelain status, and a complete tracked/untracked non-ignored path/type/
  content-hash snapshot before any scratch work; compare all four in `finally`
  on success and failure. Status alone cannot detect changed bytes inside a path
  that was already `M` or `??` at entry.
- `changeset version` consumes inputs and changes manifests/changelogs. It must
  run only under an OS temp directory with unconditional cleanup.
- Generated changelog hash prefixes/order depend on commit history. Assert exact
  versions, headings, normalized summaries, and allowed paths, not hashes or
  byte ordering.
- `printf '%s'` is intentional: `echo` may add a newline or interpret escapes.
  Do not pass the token through a command string, argv, environment variable,
  test output, or fixture filename.
- The token test's outer case root contains the captured sentinel stdin even
  after the helper removes its own workdir. Remove the complete case root in
  `finally` and verify absence without printing captured bytes.
- The root CI workflow currently invokes package tests directly. The durable
  token-helper test is not protected until explicitly added to the build job.
  The release-specific exact-version verifier must remain an operator command:
  permanently adding it to CI would block the generated Version Packages PR and
  later releases after the pinned versions become historical.

## Implementation Blueprint

### Tasks

```yaml
Task 1: Normalize release metadata and restore stable feature prose
  MODIFY examples/nextjs/package.json:
    - Add exactly `"version": "0.0.0"` after the package name; retain `private: true`.
  CREATE .changeset/browser-rum-lifecycle.md:
    - Select only `@pydantic/logfire-browser: minor`.
    - Use exactly the established alpha sentence from the browser changelog, including opt-in lazy `autoInstrumentations`.
    - Do not select replay/private examples or edit generated stable changelogs in place.
  ENABLES: CX-9
  VERIFY:
    - COMMAND: pnpm exec changeset status --output /tmp/logfire-r8-status.json
    - EXPECTED: Browser 0.17.0 with ten exact Changeset IDs, replay 0.1.0 with six exact IDs, private client 0.1.16, no Next.js/null/other public release.

Task 2: Build the disposable release-plan verifier
  CREATE scripts/verify-browser-release-plan.mjs:
    - Use Node built-ins only; locate repository root, resolve package.json/bin paths for `@changesets/cli`, `@changesets/assemble-release-plan`, and `@changesets/apply-release-plan` from the source tree, and fail before scratch creation unless their versions are exactly 2.30.0, 6.0.9, and 7.1.0.
    - Invoke the resolved 2.30.0 CLI bin with `process.execPath`; do not use a PATH-selected `changeset` shim.
    - Before any work, capture source HEAD, `git ls-files --stage -z`, and `git status --porcelain=v1 -z --untracked-files=all` as bytes, plus a complete source path/type/content-hash snapshot of every tracked and untracked non-ignored file; exclude only `.git` and agreed dependency/build directories.
    - Create one dedicated OS-temp clone, overlay all tracked/untracked non-ignored live files, mirror tracked deletions, and create a local `main` ref from source `main` or a documented HEAD fallback solely so status can compute divergence.
    - Snapshot the complete scratch path/hash/type state after overlay and before versioning, excluding only `.git` and linked/ignored dependency/build directories.
    - Run `changeset status --output` in scratch and parse JSON. Assert pre mode `exit`, exact release names/types/old/new versions, no null, and no additional non-`none` release.
    - Require browser IDs exactly `[browser-optional-feature-api, browser-provider-reconfiguration, browser-proxy-example-safety, browser-replay-privacy-defaults, browser-rum-lifecycle, browser-rum-session, browser-rum-web-vitals-metrics, browser-rum-web-vitals, browser-session-replay-integration, stable-browser-rum-lifecycle]` and replay IDs exactly `[browser-optional-feature-api, browser-replay-privacy-defaults, browser-session-replay-integration, replay-delivery-reliability, session-replay-package, stable-browser-rum-lifecycle]`.
    - Run the resolved `changeset version` only in scratch. Never construct or expose a publish command.
    - Assert browser 0.17.0, replay 0.1.0, private client 0.1.16, Next.js unchanged 0.0.0, every other manifest version unchanged, and no null manifest/changelog value.
    - Compare the full before/after path union and allow exactly six modified files (the browser, replay, and private-client manifest/changelog pairs), deletion of `.changeset/pre.json`, and deletion of exactly the twelve input Changesets; reject every other modification, creation, deletion, symlink/type change, Next.js changelog, or lockfile change.
    - Require the generated private client section `## 0.1.16` to name `@pydantic/logfire-browser@0.17.0` and contain no null value.
    - Parse only the new 0.17.0/0.1.0 changelog sections; normalize whitespace and require every selected Changeset summary, including the exact `autoInstrumentations` sentence in browser, explicitly require that sentence to be absent from replay, and do not pin hashes/order.
    - In `finally`, remove scratch, prove it is gone, and compare source HEAD/index/status bytes plus the complete source path/type/content-hash snapshot on both success and failure; source drift is a verifier failure even when the primary assertion also failed.
    - Emit a concise deterministic pass/failure report with no source status content or secrets.
  PATTERN: plans/research/030-browser-release-integrity/spike-01-changesets-exit-artifacts.md
  ENABLES: CX-9
  VERIFY:
    - COMMAND: node scripts/verify-browser-release-plan.mjs
    - EXPECTED: One PASS summary naming the exact three releases and allowed generated artifacts; source HEAD, index entries, status, path types, and every tracked/untracked non-ignored file byte are unchanged from verifier entry.

Task 3: Remove token argv exposure and test the real helper boundary
  MODIFY scripts/create-npm-token.sh:
    - Replace `--body "$TOKEN"` with `printf '%s' "$TOKEN" | gh secret set NPM_TOKEN --repo "$REPO" --env "$ENVIRONMENT" >/dev/null`.
    - Preserve set -euo pipefail, repository/environment, auth checks, interactive npm token creation, extraction fallbacks, stdout wording, temp directory, and EXIT trap.
  CREATE scripts/create-npm-token.test.mjs:
    - For each case create a controlled temp root and fake executable PATH before starting the actual Bash helper.
    - Fake mktemp creates and returns a known token workdir; fake script writes a literal runtime sentinel from its own fixture body (not parent argv/environment) into the helper's expected token file; fake npm accepts only the exact whoami call; fake gh accepts only exact auth status and secret set calls.
    - Make fake `gh secret set` emit a known non-secret stdout marker after capturing input. Capture argv as NUL-safe entries and stdin as bytes; assert exact argv `[secret,set,NPM_TOKEN,--repo,pydantic/logfire-js,--env,npm]`, no `--body`/sentinel, exact sentinel stdin with no newline, and neither the sentinel nor fake-gh marker in helper stdout/stderr.
    - Run success and a secret-set exit-23 case independently; assert exit 0/23 respectively and removed controlled token workdir in both.
    - Wrap each outer case root in `try/finally`, remove the entire root on every assertion/spawn path, and verify absence without logging captured stdin or sentinel content.
    - Ensure any unexpected fake invocation fails and no real gh/npm/script can be resolved.
  ENABLES: CX-9F
  VERIFY:
    - COMMAND: bash -n scripts/create-npm-token.sh && node scripts/create-npm-token.test.mjs
    - EXPECTED: Both isolated cases pass exact argv/stdin/leak/exit/cleanup assertions with no authentication or network.

Task 4: Strengthen only deterministic release-owned tests
  MODIFY packages/logfire-browser/src/BrowserSessionSpanProcessor.test.ts:
    - Set location explicitly where needed and exact-match complete stable session/page/replay attribute objects, including both session IDs and absence-by-exact-object rather than follow-up negative assertions.
  MODIFY packages/logfire-browser/src/webVitals.test.ts:
    - Exact-match shared observer option projections and use exact `['second-tracer']` arrays in the two latest-recorder/lifecycle cases.
    - Keep attribution maps partial where the test intentionally selects fields.
  MODIFY packages/logfire-browser/src/index.test.ts:
    - Exact-match stable instrumentation registration objects where the mock owns all keys.
    - For Web Vitals startup, project stable scalar options plus `tracer.name` and exact-match the projection; do not deep-match tracer functions.
  MODIFY packages/logfire-browser/src/sessionReplay.test.ts:
    - Replace three diagnostic stringContaining assertions with the exact production diagnostic and the identical captured Error object; table invalid-URL messages exactly by input.
  MODIFY packages/logfire-session-replay/src/recorder.test.ts:
    - Change the five-key sampling configuration to exact equality; keep optional-field selection partial because rrweb options intentionally contain other owned keys/functions.
  MODIFY packages/logfire-session-replay/src/transport.test.ts:
    - Exact-match deterministic request header objects.
    - In maxBufferBytes, wait for/assert the upload before shutdown, then assert shutdown creates no second upload and the decoded timestamps remain `[1, 2]`.
  MODIFY packages/logfire-session-replay/src/index.test.ts:
    - Replace the interval spy assertion with a full snapshot, a 5000 ms fake-time advance, and one decoded upload at the exact session URL; then stop without an extra upload.
  MODIFY packages/logfire-session-replay/src/capture.test.ts:
    - Exact-match deterministic console payloads and all ten serialized arguments; first is 1024 `x` characters plus `...(+3976 chars)`, followed by strings `1` through `9`.
    - Retain partial matching for extensible fetch/XHR payloads and scalar-focused byte/redaction tests; they are outside the exact console-truncation review contract.
  ENABLES: Supporting regression evidence for CX-9; no runtime behavior change.
  VERIFY:
    - COMMAND: vp run @pydantic/logfire-browser#test -- src/BrowserSessionSpanProcessor.test.ts src/webVitals.test.ts src/index.test.ts src/sessionReplay.test.ts
    - EXPECTED: All selected browser tests pass with no production-source diff.
    - COMMAND: vp run @pydantic/logfire-session-replay#test -- src/recorder.test.ts src/transport.test.ts src/index.test.ts src/capture.test.ts
    - EXPECTED: All selected replay tests pass; threshold and interval cases prove observable uploads.

Task 5: Integrate durable token evidence without freezing future releases
  MODIFY package.json:
    - Add `test:release-tooling` running only the fake-command token test and append it to `check` after package tests.
    - Add `verify:browser-rum-release-plan` running the disposable exact-version verifier as an explicit R8/R9 operator command.
    - Do not put the exact-version verifier in `test`, `check`, or `release`.
  MODIFY .github/workflows/main.yml:
    - Add a build-job step running `pnpm run test:release-tooling` after existing package tests.
    - Do not change permissions, branch condition, environment, Changesets action, tokens, or publish command.
  ENABLES: CX-9, CX-9F and the R9 handoff.
  VERIFY:
    - COMMAND: pnpm run test:release-tooling && pnpm run verify:browser-rum-release-plan
    - EXPECTED: Fake token success/failure and disposable Changesets generation both pass; only the token test is part of permanent check/CI, and no live manifest, changelog, Changeset, git index, credential, network, or external state changes.
```

### Integration Points

```yaml
RELEASE_METADATA:
  - examples/nextjs/package.json — private version makes Changesets skip it correctly.
  - .changeset/browser-rum-lifecycle.md — browser-only stable feature inventory.
  - .changeset/pre.json — read/assert in live tree; consumed only in scratch.

MAINTAINER_SECURITY:
  - scripts/create-npm-token.sh — token crosses into gh only through stdin.
  - scripts/create-npm-token.test.mjs — fake child-process contract and cleanup evidence.

RELEASE_VALIDATION:
  - scripts/verify-browser-release-plan.mjs — status/version outside-in gate.
  - package.json — permanent token test plus explicit release-specific operator command.
  - .github/workflows/main.yml — required token-helper evidence before release action can run on main.
```

## Validation

```bash
: 'Baseline and exact release plan; live tree remains unmodified by versioning'
git rev-parse HEAD
git status --short
pnpm exec changeset --version
pnpm exec changeset status --output /tmp/logfire-r8-status.json
node scripts/verify-browser-release-plan.mjs

: 'Secret boundary'
bash -n scripts/create-npm-token.sh
node scripts/create-npm-token.test.mjs

: 'Focused deterministic tests'
vp run @pydantic/logfire-browser#test -- src/BrowserSessionSpanProcessor.test.ts src/webVitals.test.ts src/index.test.ts src/sessionReplay.test.ts
vp run @pydantic/logfire-session-replay#test -- src/recorder.test.ts src/transport.test.ts src/index.test.ts src/capture.test.ts

: 'Integrated durable gate and release-specific operator gate'
pnpm run test:release-tooling
pnpm run verify:browser-rum-release-plan
pnpm run check
git diff --check
git status --short
```

The `CX-9`/`CX-9F` table is authoritative. Test output is direct only when the
actual installed Changesets CLI or actual helper script crosses the described
local boundary. A hand-written expected JSON/changelog or source inspection
alone is not acceptance evidence. If the disposable verifier cannot include the
complete live inventory, record `UNVERIFIED`; never run versioning in place as a
substitute.

## Unknowns & Risks

- CI shallow-checkout topology may not expose a local `main` ref. The verifier's
  documented HEAD fallback is acceptable only for Changesets' divergence
  prerequisite; exact release-plan and generated-artifact assertions remain
  mandatory and independent of changed-package warnings.
- Generated changelog formatting and commit prefixes can vary with final merge
  history. Normalized exact summaries and allowed artifact paths prevent both
  brittle hash assertions and silent feature loss.
- The current worktree contains the in-progress R8 metadata and verifier files.
  A clone of HEAD without the live overlay would omit them and produce invalid
  R8 evidence.
- The token fixture controls executable resolution and generated token content.
  It must avoid placing the sentinel in the parent's argv/environment before the
  helper generates it, or the process-leak assertion becomes meaningless.

**Confidence: 9/10** for one-pass implementation success.

## Execution Notes

- **Executed**: 2026-07-13 from clean source baseline `99f7285`. The earlier
  dirty R7 planning baseline was reconciled because R7 and the planning
  artifacts are now committed; R8's scope and exact release contract did not
  change.
- **Scope**: matched the expected change set. No SDK runtime/API code, package
  dependency policy, release action, permissions, external state, or live
  generated manifest/changelog was changed.
- **Focused-gate correction**: the interval-upload assertion initially observed
  the timer before asynchronous compression completed. It now waits for the
  observable request, then proves stop produces no second upload; the focused
  replay test and final integrated suite pass.
- **Unresolved risks**: none within R8. Publication, merge operations, registry
  state, tags/releases, dist-tags, and branch deletion remain reserved for R9.

## Verification Record

- **Verified**: 2026-07-13 from source baseline `99f7285` with all R8 changes
  intentionally uncommitted.
- **Assurance**: the Deep PRP already had an equivalent fresh-context cold
  review, and preflight exposed no new high-risk uncertainty after the baseline
  reconciliation. Final execution received complete self-review against the
  PRP, parent invariants, exclusions, and both acceptance scenarios.

| Scenario | Grade               | Direct evidence                                                                                                                                                                                                                                                                                                                                                            | Limitations                                                                                                                |
| -------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `CX-9`   | `DIRECTLY VERIFIED` | `node scripts/verify-browser-release-plan.mjs` resolved CLI 2.30.0, assemble 6.0.9, and apply 7.1.0; overlaid the complete live tree into a local clone; proved the exact browser `0.17.0`, replay `0.1.0`, and private-client `0.1.16` plan and generated artifacts; removed scratch; and verified source HEAD, index, status, path types, and file bytes unchanged.      | Local installed Changesets behavior only; publication and the future Version Packages PR remain intentionally unexercised. |
| `CX-9F`  | `DIRECTLY VERIFIED` | `node scripts/create-npm-token.test.mjs` exercised the real Bash helper through controlled fake `mktemp`, `script`, `npm`, and `gh` binaries for success and exit 23. Exact secret-setting argv omitted `--body` and the token, stdin matched the generated sentinel without a newline, output contained no secret/gh marker, and both helper and case roots were removed. | Uses a generated sentinel and fake external commands by design; no authentication, network, or GitHub secret was touched.  |

### Compliance and Engineering Evidence

- All eight success criteria and five blueprint tasks are implemented; the
  pause conditions and exclusions held.
- The disposable verifier permits only the six expected generated
  manifest/changelog modifications and thirteen exact Changeset/pre-state
  deletions in scratch, rejects every other path/type/version/null artifact,
  and performs source-preservation checks on success and failure.
- The exact-version verifier remains an operator-only command. Only the
  version-independent token boundary test is part of root `check` and CI.

| Gate                                                                                   | Result                                                                                                            |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Browser focused deterministic tests                                                    | 13 files, 151 tests passed                                                                                        |
| Replay focused deterministic tests                                                     | 4 files passed; corrected `index.test.ts` passed 41/41 and the full replay suite passed 143/143 in the final gate |
| `pnpm run test:release-tooling`                                                        | Passed fake success/failure argv, stdin, leak, exit, and cleanup evidence                                         |
| `pnpm run verify:browser-rum-release-plan`                                             | Passed exact plan/generated artifacts and source-preservation evidence                                            |
| `pnpm run check`                                                                       | Passed builds, 436-file formatting, lint, all typechecks, all package tests, and the release-tooling test         |
| `node --check` for both new scripts, `bash -n scripts/create-npm-token.sh`, diff check | Passed                                                                                                            |
