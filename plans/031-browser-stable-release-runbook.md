# PRP: Publish the Browser RUM Stable Release

## Goal

Merge PR #161 through the repository's normal Changesets path, publish
`@pydantic/logfire-browser@0.17.0` and
`@pydantic/logfire-session-replay@0.1.0` as the official stable packages, prove
the registry artifacts reproduce the verified browser/replay contract, complete
the downstream handoff, and only then retire the feature branch.

## Why

- Browser and standalone replay integrators need the reviewed stable contract
  to be available from npm `latest`, not only from historical alpha versions.
- Release operators need fail-closed checkpoints around two PR merges, npm
  publication, GitHub release metadata, handoff, and branch deletion.
- PR #161 currently points at an older remote head and carries unresolved review
  state, so existing green checks are not evidence for the complete candidate.

## Success Criteria

- [x] The local candidate is clean, fully validated, pushed, and represented by
      fresh successful PR checks against the exact remote head.
- [x] Every PR #161 review thread is dispositioned against the pushed candidate,
      an accepted reviewer approval exists, and `CHANGES_REQUESTED` is cleared
      before merge even though `main` is not repository-protected.
- [x] The feature PR merges without publishing, and the resulting main-branch
      run creates or updates the normal `Version Packages` PR.
- [x] The Version Packages PR contains exactly browser `0.17.0`, replay `0.1.0`,
      and private client `0.1.16`; its generated artifacts, checks, and
      scratch-clone package/consumer smoke tests pass before merge.
- [x] The Version Packages merge publishes exactly the two public stable
      packages; npm `latest`, tarball contents/imports, package compatibility,
      and required GitHub tags/releases are directly verified.
- [x] Registry-installed browser checks re-exercise parent `CX-1`, `CX-5`, and
      `CX-8`; the R1-R8 verification records remain applicable to the exact
      published source.
- [x] The downstream Platform handoff is recorded, the feature branch is absent,
      its squash-equivalent content is verified after the evidence gate, and
      existing `alpha` dist-tags remain unchanged. GitHub's automatic branch
      deletion preempted the planned explicit post-evidence deletion; the exact
      tree comparison and later no-publication snapshot record the recovery.
- [ ] Publication/handoff evidence is merged to `main` through a dedicated
      evidence PR before branch deletion; a final cleanup PR records deletion
      with a conditional terminal gate, and the roadmap becomes complete only
      when the merged cleanup PR's authorized terminal comment proves that its
      own exact-SHA main run passed without publication or public-state change.

## Assurance

- **Profile**: Deep
- **Rationale**: merging the Version Packages PR triggers an externally visible
  npm publication that is not safely reversible, while the release crosses
  GitHub review/merge state, Changesets generation, npm package/dist-tag state,
  real package consumers, and GitHub tags/releases. The unprotected `main`
  branch makes procedural gates load-bearing. No new runtime architecture or
  public API is introduced.

## Roadmap Context

- **Parent roadmap**:
  `plans/roadmaps/001-browser-rum-release-remediation.md`
- **Roadmap step**: `R9` — integrate, merge, and publish the official stable
  release.
- **Satisfied dependencies**: R1-R8 are verified. Their completion records prove
  recursion prevention, ownership-safe lifecycle, replay delivery, failure
  containment, privacy defaults, stable optional-feature API, safe
  proxies/examples, and deterministic release tooling. PRP 030 directly proved
  the exact stable version plan and secret-safe token transport at `0cb505b`.
- **Inherited decisions and invariants**: use feature PR -> Version Packages PR
  -> main-branch publish; never publish directly from the feature branch; keep
  historical alpha packages available; do not change the replay envelope or
  stable API; never treat missing credentials, review state, or registry
  evidence as success.
- **Contract produced for later steps**: final public npm/GitHub evidence and a
  downstream handoff record sufficient to mark the roadmap complete.

## Consumer Contract

### Consumer and Public Boundary

- **Consumer(s)**: browser SDK integrators, standalone replay integrators,
  release operators, and the downstream Logfire Platform team.
- **Public or supported boundary**: PR #161 and its checks/reviews, the generated
  Version Packages PR, npm package metadata/tarballs/dist-tags, documented
  package imports and browser configuration, Git tags/releases, and the
  downstream handoff record.
- **Entry point and prerequisites**: a clean local candidate with R1-R8 verified;
  GitHub merge rights; successful CI; the repository `npm` environment and
  publish credentials/trusted workflow; registry access; and explicit operator
  authorization at each external mutation.
- **Current observable behavior**: PR #161 is open at remote head `f57d9ec`,
  while the clean local branch is six commits ahead at `0cb505b`. Existing CI
  and CodeRabbit status are green for the old remote head, but the PR still has
  19 unresolved, non-outdated CodeRabbit threads and reports
  `CHANGES_REQUESTED`. npm currently resolves browser `latest` to `0.16.4` and
  replay `latest` to `0.1.0-alpha.1`.
- **Observable promise**: after the authorized release sequence, npm `latest`
  resolves to browser `0.17.0` and replay `0.1.0`; the actual registry tarballs
  import and behave like the verified candidate; GitHub release metadata and the
  handoff exist; and no branch is removed before that proof.
- **Must remain compatible with**: the parent roadmap's `CX-1`-`CX-9` contracts,
  the accepted alpha call shapes retained by R6, the optional browser-to-replay
  peer relationship, the repository's Changesets workflow, and historical
  alpha artifacts.
- **Not claimed**: rollback of an already published npm version, deletion of
  alpha versions or dist-tags, downstream Platform implementation, or safety of
  merging/publishing when any required external evidence is unavailable.

### Acceptance Scenarios

| ID       | Given                                                                                                                                     | When                                                                                    | Then                                                                                                                                                                                                                                                                                                        | Exact exercise and prerequisites                                                                                                                                                                                                     | Required evidence                                                                            |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `CX-10A` | The clean local candidate contains all R1-R8 work but PR #161 points at an older head with unresolved review state                        | The operator authorizes push and review disposition                                     | The PR head equals the local candidate, fresh CI and CodeRabbit checks pass for that exact SHA, every thread is resolved or explicitly answered, and no `CHANGES_REQUESTED` review remains before merge                                                                                                     | Compare local/remote/PR SHAs; run the thread-aware review script; inspect every current thread and check rollup; obtain approval before push, replies, resolutions, or re-review requests                                            | DIRECT REQUIRED — GitHub is the supported merge boundary                                     |
| `CX-10B` | `CX-10A` is green and the feature-PR merge is authorized                                                                                  | PR #161 merges and its main-branch workflow completes                                   | The merged source is present on `main`, no stable npm version changed from the feature merge, and the normal `changeset-release/main` Version Packages PR is created or updated                                                                                                                             | Record merge SHA; inspect the exact main run/jobs; query npm before/after; locate the Version Packages PR by base/head                                                                                                               | DIRECT REQUIRED — proves the feature merge did not bypass Changesets                         |
| `CX-10C` | The Version Packages PR is based on the merged feature SHA                                                                                | Its diff, generated files, CI, scratch-clone packs, and minimal consumers are inspected | The candidate is exactly browser `0.17.0`, replay `0.1.0`, and private client `0.1.16`; no unintended release/null value appears; ESM/CJS/types and browser/replay package linkage work from packed artifacts                                                                                               | Fetch the Version Packages PR head into a disposable clone; frozen install; full check; release-plan comparison; `pnpm pack --json`; tarball allow/deny inspection; clean ESM/CJS/type/browser consumer exercises                    | DIRECT REQUIRED — exercises the exact pre-publish commit without changing the live workspace |
| `CX-10`  | `CX-10C` is green and the Version Packages merge is separately authorized                                                                 | The Version Packages PR merges and the main release job completes                       | npm `latest` resolves to browser `0.17.0` and replay `0.1.0`; actual registry tarballs have the expected manifests/content/imports and pass parent `CX-1`, `CX-5`, and `CX-8` smoke rechecks; required tags/releases exist; the downstream handoff is recorded; only then may the feature branch be deleted | Inspect workflow job steps and logs; poll boundedly for npm propagation; pack/install exact registry versions in a fresh scratch consumer/browser fixture; query Git refs/releases; record handoff and authorize deletion separately | DIRECT REQUIRED — this is the parent roadmap's public release boundary                       |
| `CX-10F` | Any required check, review, generated artifact, publish output, registry value, tag/release, or consumer smoke result is missing or wrong | The release run reaches the next mutation gate                                          | Execution stops without merging the next PR, changing dist-tags, deleting the feature branch, or claiming completion; the observed partial state and recovery owner are recorded                                                                                                                            | Evaluate every gate immediately before mutation; preserve logs, SHAs, registry responses, and scratch results                                                                                                                        | DIRECT REQUIRED — fail-closed recovery is essential around irreversible publication          |

The parent roadmap remains authoritative for `CX-1`, `CX-5`, and `CX-8`.
R9 re-executes their named public boundaries from the exact registry packages;
it does not redefine their observable promises.

## Research Summary

### Vetted Repository Findings

- `.github/workflows/main.yml:41-75` — the release job runs only after the build
  job succeeds on `main`; `changesets/action@v1` owns Version Packages creation
  or `pnpm run release` publication and receives repository/npm credentials. —
  **PRP impact**: every PR merge into `main`, including documentation-only
  evidence PRs, must be followed through its exact main run; a PR check alone
  cannot prove release behavior.
- `.github/workflows/main.yml:76-91` — Git tags/releases are created only when
  the Changesets action reports `published == 'true'`. — **PRP impact**: a green
  release job may legitimately skip this step, so npm state and the step outcome
  must be inspected rather than inferred from the workflow conclusion.
- `package.json:11-19` — `pnpm run check` covers build, Vite+ static checks,
  typecheck, package tests, and release-tooling tests; the permanent exact-plan
  verifier is a separate command. — **PRP impact**: both commands are required
  before the first merge and on the Version Packages candidate.
- `packages/logfire-browser/package.json:29-44` and
  `packages/logfire-session-replay/package.json:28-43` — both packages expose
  explicit ESM, CJS, and declaration entries. — **PRP impact**: tarball smoke
  must cover `import`, `require`, and type resolution, not only file presence.
- `packages/logfire-browser/package.json:67-75` — browser declares replay as an
  optional workspace peer. — **PRP impact**: the versioned packed manifest must
  resolve it to a compatible stable range and consumers must pass with and
  without replay installed.
- `plans/030-browser-release-integrity.md:585-603` — PRP 030 directly verified
  exact Changesets output and token secrecy while explicitly leaving publication
  and the future Version Packages PR unexercised. — **PRP impact**: inherit the
  exact plan, but require new evidence from the actual generated PR and registry.
- `packages/logfire-browser/test-fixtures/self-observation`,
  `packages/logfire-browser/test-fixtures/privacy-defaults`, and
  `packages/logfire-browser/test-fixtures/optional-feature-api` — the existing
  built-package fixtures provide the closest outside-in patterns for parent
  `CX-1`, `CX-5`, and `CX-8`. — **PRP impact**: adapt these patterns in scratch
  to import exact packed/registry packages rather than local source aliases.
- Live GitHub inspection on 2026-07-13 — PR #161 is open/mergeable at
  `f57d9ec`, but reports `CHANGES_REQUESTED`; all 19 review threads are
  unresolved and non-outdated; the local branch is six commits ahead. —
  **PRP impact**: push, fresh review, and thread-aware disposition precede merge.
- Live GitHub API inspection on 2026-07-13 returned no branch-protection object
  for `main`. — **PRP impact**: enforce review/check/authorization gates in this
  runbook even when GitHub would permit bypass.
- Main run `28934739451` from merged Version Packages PR #160 was green while
  `Create GitHub releases` was skipped. — **PRP impact**: green workflow status
  alone never proves publication or release metadata; inspect step outputs and
  public state independently.

### External Constraints

- [PR #161](https://github.com/pydantic/logfire-js/pull/161) — current GitHub
  review, check, head, and merge boundary; all observations must be refreshed at
  execution time.
- npm registry on 2026-07-13 — browser has `latest=0.16.4` and
  `alpha=0.17.0-alpha.2`; replay has `latest=alpha=0.1.0-alpha.1`. — Publication
  must move only `latest` to the intended stable versions and preserve the
  observed `alpha` tags.

### Settled Decisions and Rejected Alternatives

- **Decision**: keep existing `alpha` dist-tags unchanged during R9. —
  **Evidence/rationale**: historical alpha packages are the rollback/debugging
  boundary; the user accepted the recommended non-destructive default on
  2026-07-13.
- **Decision**: require explicit operator authorization immediately before push,
  each PR merge, any GitHub review-thread write, downstream handoff send, and
  branch deletion. — **Evidence/rationale**: these are external mutations with
  different failure and recovery boundaries.
- **Decision**: treat missing GitHub protection as a reason for stronger manual
  gates, not permission to bypass review or CI. — **Evidence/rationale**: the
  roadmap promises normal reviewed PR flow.
- **Decision**: perform pre-publish package work in a disposable clone/scratch
  consumer and post-publish work from registry tarballs. — **Evidence/rationale**:
  package `prepack` copies `LICENSE`; scratch isolation prevents release checks
  from dirtying or rewriting the live candidate.
- **Rejected**: direct stable publish from the feature branch. — **Reason**:
  bypasses the inherited Changesets contract and Version Packages review.
- **Rejected**: force-merging while `CHANGES_REQUESTED` remains merely because
  `main` is unprotected. — **Reason**: contradicts `CX-10A` and invalidates the
  review gate.
- **Rejected**: deleting or moving `alpha` tags as part of stable verification.
  — **Reason**: unnecessary mutation with no stable-release benefit.
- **Rejected**: assuming a successful Actions run proves npm publication or
  GitHub releases. — **Reason**: recent repository history demonstrates that a
  green run can skip the release-creation step.

### Spike Evidence

- None needed. R8 exercised the exact Changesets versions and generated
  artifacts in isolation. R9's remaining unknowns are live operational state
  with fail-closed observation gates, not architecture-changing empirical
  questions.

### Validation Baseline

| Command                                          | Status                 | Observed or expected result                                                                        |
| ------------------------------------------------ | ---------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm run check`                                 | Verified               | Passed immediately before commit `0cb505b`, including full package tests and release-tooling tests |
| `pnpm run verify:browser-rum-release-plan`       | Verified               | Passed at `0cb505b`: browser `0.17.0`, replay `0.1.0`, private client `0.1.16`; source preserved   |
| Thread-aware PR review fetch                     | Verified               | 19 unresolved, non-outdated CodeRabbit threads on remote head `f57d9ec`                            |
| Fresh PR CI/review for the complete candidate    | Baseline failing       | Remote PR head omits six local commits and retains `CHANGES_REQUESTED`                             |
| Version Packages scratch-clone pack/import smoke | Discovered but not run | Requires the Version Packages PR created after feature merge                                       |
| Registry-installed stable consumer smoke         | Unavailable            | Stable `0.17.0`/`0.1.0` artifacts are not yet published; required after authorized publication     |

### Research Coverage

- **Depth**: Deep
- **Inspected**: R9 parent contract and R1-R8 completion summaries; root
  validation/release scripts; current package manifests/exports/peer contract;
  Changesets exit state; CI/release workflow; current PR/check/review threads;
  recent Version Packages PR/run behavior; npm dist-tags; package consumer
  fixtures; current branch history and status.
- **Not inspected**: downstream Platform implementation (out of scope); npm or
  GitHub secret values (must never be read or logged); unrelated packages and
  historical releases beyond the workflow analogue.
- **Research confidence**: HIGH for the sequence and evidence surfaces. Live
  GitHub/npm state remains intentionally rechecked at every execution gate.

## Execution Contract

- **Planned at commit**: `0cb505b`
- **Planning baseline**: clean source tree on
  `petyosi/browser-rum-alpha-release`, six commits ahead of its remote. This PRP
  and the parent-roadmap link are the only expected planning changes after
  generation and must be committed before release execution can require a clean
  candidate.

### Expected Changes

- `plans/031-browser-stable-release-runbook.md` — append execution deviations and
  final verification evidence only as the run proceeds.
- `plans/roadmaps/001-browser-rum-release-remediation.md` — record R9 status,
  checkpoints, and completion evidence.
- `scripts/verify-browser-release-artifacts.mjs` — deterministic scratch-clone
  and registry-tarball verifier for exact ESM/CJS/types/browser consumers; this
  is manual release tooling and must not permanently pin future CI to these
  versions.
- GitHub PR #161 — pushed commits, review dispositions, fresh checks, and merge.
- GitHub `changeset-release/main` PR — action-generated version manifests,
  changelogs, and consumed Changesets; no hand-authored release delta unless the
  generated plan fails and R9 pauses.
- npm registry — browser `0.17.0` and replay `0.1.0` publication plus `latest`
  movement; existing `alpha` tags unchanged.
- Git refs/releases — workflow-created package tags and releases for the two
  published public packages.
- Downstream handoff destination — send the already bounded SDK contract and
  public version evidence only after explicit authorization.

No SDK source change is expected. If review or validation requires one, stop
R9, preserve the partial state, implement and verify the defect as a scoped
follow-up, update affected roadmap evidence, and restart the invalidated gates.

### Explicitly Out of Scope

- New browser/replay runtime behavior, public API, privacy default, wire schema,
  proxy behavior, or release automation.
- Publishing any package other than the intended Changesets output.
- Direct publication from the feature branch or a local workstation.
- Removing/moving `alpha` dist-tags or deleting published alpha versions.
- Downstream Platform code changes.
- Silently resolving review threads without verifying their requests against the
  pushed candidate.

### Scope Expansion Rule

Additional evidence scripts may be created only in disposable scratch space.
Record any unexpected repository or external-system change in Execution Notes.
Pause for user direction if expansion changes runtime behavior, a public API or
schema, release versions, workflow/authentication, package scope, review policy,
rollback posture, or downstream ownership.

### Pause and Reassess If

- The local candidate is dirty, cannot be tied to one pushed SHA, or no longer
  reproduces the exact R8 release plan.
- Any of the 19 existing threads remains substantively unaddressed, a new review
  finding appears, or `CHANGES_REQUESTED` cannot be cleared.
- Fresh PR checks are absent, skipped unexpectedly, stale, or not successful for
  the exact candidate SHA.
- The feature merge changes npm stable state, fails to produce a Version
  Packages PR, or the generated PR is not based on the merged feature source.
- The generated versions, peer ranges, changelogs, consumed Changesets, package
  contents, or release set differ from browser `0.17.0`, replay `0.1.0`, and
  private client `0.1.16`.
- The Version Packages PR merge would publish from an unexpected SHA, package
  set, identity, token path, or workflow revision.
- The publish job fails or succeeds without direct registry confirmation;
  `latest` moves incorrectly; `alpha` changes; a required tag/release is absent;
  or any actual registry tarball/consumer smoke fails.
- A registry mismatch persists beyond a bounded propagation wait. Record
  `UNVERIFIED`; do not retry publication or delete the branch.
- The downstream handoff destination/owner is unavailable. Publication may be
  recorded, but roadmap completion and branch deletion remain blocked.
- A publication-evidence PR cannot be reviewed and merged to `main` before
  branch deletion, or the final cleanup PR cannot durably record the deletion.

## Context

### Key Files

- `.github/workflows/main.yml` — exact CI, Changesets, publish, tag, and GitHub
  release sequence.
- `.changeset/pre.json` and `.changeset/config.json` — exit-mode inputs and
  release-policy configuration consumed by the Version Packages PR.
- `scripts/verify-browser-release-plan.mjs` — source-preserving exact-plan gate.
- `scripts/create-npm-token.test.mjs` — release-credential argv/stdin regression
  gate; never run the real token helper as a release smoke test.
- `packages/logfire-browser/package.json` — browser exports and optional replay
  peer contract.
- `packages/logfire-session-replay/package.json` — replay exports and publish
  manifest.
- `packages/logfire-browser/test-fixtures/self-observation` — parent `CX-1`
  public browser receipt pattern.
- `packages/logfire-browser/test-fixtures/privacy-defaults` — parent `CX-5`
  decoded telemetry/replay pattern.
- `packages/logfire-browser/test-fixtures/optional-feature-api` — parent `CX-8`
  built consumer/types/lifecycle pattern.
- `plans/030-browser-release-integrity.md` — inherited exact release-plan and
  secret-safety verification record.

### Gotchas

- `main` is not GitHub-protected. Mergeability is not authorization and cannot
  override the PRP's review/check gates.
- PR check rollups can describe an older remote head. Compare SHA first, then
  interpret checks and review state.
- GitHub's flat review view does not preserve resolution/outdated state. Use the
  thread-aware GraphQL review script and inspect every current thread.
- `changesets/action` has two modes: with pending Changesets it creates/updates
  the Version Packages PR; after that PR merges it publishes. The feature merge
  must not itself publish stable packages.
- Every later evidence/cleanup PR merge also invokes the main release job. Take
  a complete registry/ref snapshot, require `published != true` with an empty
  published-package set, and prove public state unchanged after each one.
- A green release job does not imply `published == true`; inspect the Release and
  Create GitHub releases step outcomes and public registry state.
- Package `prepack` copies `LICENSE`. Run pack operations only in scratch clones
  and assert cleanup there; never let smoke tests dirty the live candidate.
- npm registry/CDN propagation can be delayed. Poll exact metadata for a bounded
  interval, but never rerun publish merely because reads lag.
- `npm view <package> version` reflects `latest`; also query the explicit version,
  all dist-tags, tarball URL, and integrity.
- Branch deletion is destructive operational cleanup, not part of publication.
  It requires verified remote merge ancestry, recorded handoff, and separate
  authorization.

## Implementation Blueprint

### Tasks

```yaml
Task 1: Freeze and validate the exact local release candidate
  CREATE scripts/verify-browser-release-artifacts.mjs:
    - Implement two explicit modes: workspace --ref <40-char SHA> and registry.
    - In workspace mode, create a disposable clone, fetch/checkout exactly the supplied SHA, install frozen dependencies, build, and pack browser/replay there; never pack in the live workspace.
    - In registry mode, npm-pack only the explicit browser/replay versions into a new temporary root.
    - In both modes, extract and parse both package.json files; require exact versions, browser's compatible optional replay peer, ESM/CJS/declaration entries, README/LICENSE/dist files, and absence of src/test/fixture/credential material.
    - Generate fresh consumer sources whose dependencies are only absolute tarball paths (workspace mode) or exact npm versions (registry mode); never copy a workspace package.json.
    - Install with an isolated npm cache, then require import.meta.resolve and require.resolve to land under that consumer's node_modules.
    - Run exact ESM import, CJS require, and tsc assertions for both packages and browser with replay absent/present.
    - Generate one registry-style Vite fixture using package-name imports only and the receipt/assertion logic of self-observation, privacy-defaults, and optional-feature-api; drive it with agent-browser and retain exact CX receipt JSON.
    - Scan every generated source/config/manifest plus resolved module path and fail on workspace:, ../../dist, /packages/, the live repository realpath, source aliases, or any package resolution outside consumer node_modules.
    - Emit one JSON evidence file containing mode, git/package SHAs, versions, integrities when available, tar entry hashes, resolved module paths, command outcomes, and browser receipts; remove all secret-bearing/scratch files in finally.
    - Refuse unspecified versions, non-exact registry specs, a dirty live source in workspace mode, or a registry version that does not match the requested exact version.
  MODIFY plans/031-browser-stable-release-runbook.md:
    - Record execution start SHA, clean status, Node/pnpm versions, and refreshed external baseline.
    - Do not modify SDK source or release metadata; record the release verifier as the only expected implementation addition.
    - After the first live-tree self-test, commit the verifier plus planning artifacts as one scoped candidate commit; rerun every Task 1 gate against that committed SHA and require a clean tree before push authorization.
  VERIFY:
    - COMMAND: git status --short --branch && git rev-parse HEAD && node --version && pnpm --version
    - EXPECTED: Clean branch; one candidate SHA; Node 24; pnpm 11.5.2.
    - COMMAND: pnpm run check
    - EXPECTED: Build, static checks, typecheck, all package tests, and release-tooling tests pass.
    - COMMAND: pnpm run verify:browser-rum-release-plan
    - EXPECTED: Exact browser 0.17.0, replay 0.1.0, private client 0.1.16 plan; source preserved.
    - COMMAND: node scripts/verify-browser-release-artifacts.mjs workspace --ref <candidate-sha> --browser-version 0.17.0-alpha.2 --replay-version 0.1.0-alpha.1 --evidence <scratch-json>
    - EXPECTED: Current exact alpha artifacts pass ESM/CJS/types/package-name browser receipts; every resolution is inside the generated consumer node_modules and no workspace/source reference survives.
  ENABLES: CX-10A, CX-10F

Task 2: Push only after authorization and re-establish the GitHub review gate
  EXTERNAL GitHub PR #161:
    - Ask for explicit push authorization, then push the current feature branch without force.
    - Require PR head SHA to equal the pushed local SHA.
    - Wait for fresh CI and CodeRabbit completion on that SHA.
    - Fetch thread-aware review state; verify each current thread against code and evidence.
    - Ask before replying, resolving threads, or requesting re-review; do not dismiss substantive findings.
    - Require an accepted reviewer approval, no unresolved actionable thread, and no CHANGES_REQUESTED review before merge approval.
  VERIFY:
    - COMMAND: gh pr view 161 --json headRefOid,mergeable,mergeStateStatus,reviewDecision,reviews,statusCheckRollup
    - EXPECTED: Exact candidate SHA; mergeable/clean; accepted reviewer approval; every required check successful; review decision not CHANGES_REQUESTED.
    - COMMAND: python3 <gh-address-comments-skill>/scripts/fetch_comments.py
    - EXPECTED: Every thread is resolved, outdated because the exact fix changed its anchor, or has an explicit accepted disposition; zero unresolved actionable threads.
  ENABLES: CX-10A, CX-10F

Task 3: Merge the feature PR and prove it did not publish
  EXTERNAL GitHub PR #161:
    - Present Task 1-2 evidence and ask for explicit merge authorization.
    - Merge through the PR; record merge method, merge SHA, actor, and time.
    - Observe the exact main-branch CI/release run to completion.
    - Confirm npm stable metadata is unchanged from the pre-merge snapshot.
    - Locate the open Version Packages PR with head changeset-release/main and verify its base contains the feature merge.
  VERIFY:
    - COMMAND: gh pr view 161 --json state,mergedAt,mergeCommit,url
    - EXPECTED: MERGED with recorded merge SHA.
    - COMMAND: gh run list --branch main --workflow CI --limit 5 --json databaseId,headSha,status,conclusion,url
    - EXPECTED: The feature merge run completes successfully; release mode creates/updates Version Packages rather than publishing.
    - COMMAND: npm info <both packages> version dist-tags --json
    - EXPECTED: Browser latest remains 0.16.4 and replay latest remains 0.1.0-alpha.1; alpha tags unchanged.
  ENABLES: CX-10B, CX-10F

Task 4: Verify the exact Version Packages candidate in isolation
  EXTERNAL GitHub Version Packages PR:
    - Record PR number, head/base SHAs, diff, checks, and review state.
    - Require an accepted reviewer/approval, no CHANGES_REQUESTED decision, and zero unresolved actionable review threads for the exact head; ask separately before any reply, resolution, or re-review request.
    - Assert the generated diff consumes the intended Changesets and pre.json, updates only expected versions/changelogs/lock metadata, and contains no null value.
    - Run the committed artifact verifier in workspace mode against the exact PR SHA; it owns the disposable clone, frozen install/build, pack inspection, isolated ESM/CJS/TypeScript consumers, package-name-only browser fixture, resolution guard, and retained receipts.
  VERIFY:
    - COMMAND: gh pr view <version-pr> --json headRefOid,mergeable,mergeStateStatus,reviewDecision,reviews,statusCheckRollup && gh pr diff <version-pr> && gh pr checks <version-pr>
    - EXPECTED: Exact intended release artifacts, accepted review/approval, no CHANGES_REQUESTED, and successful checks for the recorded head SHA.
    - COMMAND: in a dedicated temporary clone checked out to the exact Version PR head, run python3 <gh-address-comments-skill>/scripts/fetch_comments.py
    - EXPECTED: Zero unresolved actionable review threads for the exact head.
    - COMMAND: node scripts/verify-browser-release-artifacts.mjs workspace --ref <version-pr-head-sha> --browser-version 0.17.0 --replay-version 0.1.0 --evidence <scratch-json>
    - EXPECTED: Browser 0.17.0 and replay 0.1.0 tarballs with compatible optional peer, required README/LICENSE/dist/declarations, no source/test/secret/workspace material, resolutions only from scratch node_modules, and exact ESM/CJS/tsc/browser receipts; Version PR diff separately proves private client 0.1.16.
  ENABLES: CX-10C, CX-10F; also supplies the parent recursion, privacy, and optional-feature smoke recheck evidence

Task 5: Merge Version Packages only after final authorization
  EXTERNAL GitHub Version Packages PR:
    - Recheck head SHA, diff, checks, accepted approval, no CHANGES_REQUESTED, zero unresolved actionable threads, and Task 4 artifacts immediately before mutation.
    - Snapshot every publishable workspace package's registry version/dist-tags plus existing relevant Git refs/releases; prove both exact target versions are absent.
    - Explain that merge triggers stable publication; ask for explicit authorization.
    - Merge through the PR and record merge SHA/time.
    - Monitor the exact main run; capture build, Release, and Create GitHub releases step conclusions without printing credentials.
    - Extract the Changesets Release step's publishedPackages output from the job log/output and require the exact set [{browser,0.17.0},{replay,0.1.0}]; missing/unreadable output is UNVERIFIED, not success.
    - Never manually rerun publish while registry outcome is uncertain.
  VERIFY:
    - COMMAND: gh pr view <version-pr> --json headRefOid,state,mergedAt,mergeCommit,reviewDecision,reviews,statusCheckRollup plus thread-aware review fetch
    - EXPECTED: The authorized, previously verified and approved head has zero unresolved actionable threads and is merged once.
    - COMMAND: gh run view <run-id> --json conclusion,headSha,jobs,url
    - EXPECTED: Run head equals merge SHA; build and release succeed; publishedPackages is exactly browser 0.17.0 and replay 0.1.0; release metadata step outcome is recorded.
  ENABLES: CX-10, CX-10F

Task 6: Verify public registry artifacts and GitHub release metadata
  EXTERNAL npm and GitHub:
    - Poll exact versions and dist-tags for a bounded propagation window.
    - Require browser latest=0.17.0 and replay latest=0.1.0; require alpha tags to equal the pre-merge snapshot.
    - Record explicit-version metadata including integrity and tarball URLs.
    - Run the committed artifact verifier in registry mode; it owns exact npm packs, manifest/content inspection, isolated ESM/CJS/TypeScript consumers, package-name-only browser fixture, resolution guard, and parent CX smoke receipts.
    - Compare the complete publishable-package registry snapshot and require that only the two intended stable versions/tags changed.
    - Verify package tags and GitHub releases point to the authorized Version Packages merge.
  VERIFY:
    - COMMAND: npm info @pydantic/logfire-browser@0.17.0 version dist.integrity dist.tarball --json; npm dist-tag ls @pydantic/logfire-browser
    - EXPECTED: Exact stable metadata; latest=0.17.0; alpha unchanged.
    - COMMAND: npm info @pydantic/logfire-session-replay@0.1.0 version dist.integrity dist.tarball --json; npm dist-tag ls @pydantic/logfire-session-replay
    - EXPECTED: Exact stable metadata; latest=0.1.0; alpha unchanged.
    - COMMAND: node scripts/verify-browser-release-artifacts.mjs registry --browser-version 0.17.0 --replay-version 0.1.0 --evidence <scratch-json>
    - EXPECTED: Actual registry artifacts match Task 4 hashes/contracts where publication metadata permits, resolve only from scratch node_modules, and directly pass the parent recursion/privacy/optional-feature smoke rechecks with no workspace/source reference.
    - COMMAND: gh release view '@pydantic/logfire-browser@0.17.0'; gh release view '@pydantic/logfire-session-replay@0.1.0'; git ls-remote --tags origin <both exact tags>
    - EXPECTED: Both tags and releases exist and correspond to the authorized release source.
  ENABLES: CX-10, CX-10F

Task 7: Complete handoff and merge durable publication evidence
  MODIFY plans/roadmaps/001-browser-rum-release-remediation.md:
    - Record publication, registry/package consumer, GitHub, and handoff evidence on a new evidence branch created from current main.
    - Keep R9 IN PROGRESS and the roadmap ACTIVE until feature-branch deletion is durably recorded.
  MODIFY plans/031-browser-stable-release-runbook.md:
    - Append Consumer Acceptance grades and reproduced engineering evidence.
  EXTERNAL downstream handoff and GitHub evidence PR:
    - Prepare the Platform handoff with stable versions, privacy/default contract, replay envelope compatibility, known duplicate-bundle limitation, and evidence links.
    - Ask before sending the handoff; record destination and acknowledgement.
    - Create a docs-only evidence branch from the verified release main SHA; commit the runbook/roadmap evidence there.
    - Ask before pushing and opening the evidence PR; require exact-head CI, review/approval, and no unresolved actionable threads.
    - Snapshot the complete publishable-package registry/dist-tag and relevant tag/release state immediately before merge.
    - Ask separately before merging the evidence PR; monitor its exact main run, require no publication, and require its evidence commit to be reachable from main before any feature-branch deletion.
    - Keep alpha dist-tags unchanged.
  VERIFY:
    - COMMAND: gh pr view <evidence-pr> --json state,headRefOid,mergeCommit,reviewDecision,statusCheckRollup plus thread-aware review fetch
    - EXPECTED: Approved evidence PR merged; publication/handoff evidence commit is reachable from main; R9 remains pending cleanup only.
    - COMMAND: gh run view <evidence-main-run> --json conclusion,headSha,jobs,url plus Release-step output and complete post-run registry/ref comparison
    - EXPECTED: Exact evidence merge SHA succeeds; published is not true, publishedPackages is empty, GitHub release creation is skipped, and every package version/dist-tag/tag/release equals the pre-merge snapshot.
  ENABLES: CX-10, CX-10F

Task 8: Delete the feature branch and merge the final cleanup record
  EXTERNAL GitHub feature branch:
    - Reconfirm publication/handoff evidence is on main, feature head is an ancestor of main, alpha tags are unchanged, and no unique remote work exists.
    - Ask separately before deleting petyosi/browser-rum-alpha-release; record the branch-deletion response and absence.
  MODIFY plans/roadmaps/001-browser-rum-release-remediation.md:
    - On a fresh cleanup branch from current main, record branch deletion and every already verified completion criterion, but keep R9 IN PROGRESS and the roadmap ACTIVE.
    - Add a terminal-completion clause tied to the exact cleanup PR: R9 becomes VERIFIED and the roadmap becomes COMPLETE only when that merged PR's final authorized comment records a successful exact-SHA main run, published != true, empty publishedPackages, unchanged registry/ref snapshot, and branch absence.
  MODIFY plans/031-browser-stable-release-runbook.md:
    - Record final CX-10/CX-10F grades, branch evidence, compliance review, and final validation.
  EXTERNAL GitHub cleanup evidence PR:
    - Commit the deletion record; ask before push/PR creation and before merge.
    - Require exact-head CI, accepted review/approval, no CHANGES_REQUESTED, and zero unresolved actionable threads.
    - Snapshot complete publishable-package registry/dist-tag and relevant tag/release state; merge only after every roadmap completion criterion except the cleanup merge's own no-publication run is evidenced.
    - Keep the file status conditional until the terminal gate is satisfied.
    - Monitor the exact cleanup-merge main run and require no publication or public registry/ref mutation.
    - After that run passes, ask before posting one final evidence comment on the merged cleanup PR with run URL/SHA, empty publication result, unchanged registry/ref snapshot, and final branch absence; this is the durable terminal record and avoids another main push/release cycle.
  VERIFY:
    - COMMAND: git merge-base --is-ancestor <feature-head> origin/main && git merge-base --is-ancestor <publication-evidence-commit> origin/main
    - EXPECTED: Both commands succeed before deletion.
    - COMMAND: git ls-remote --heads origin petyosi/browser-rum-alpha-release
    - EXPECTED: No matching branch after authorized deletion.
    - COMMAND: gh pr view <cleanup-pr> --json state,mergeCommit,reviewDecision,statusCheckRollup plus thread-aware review fetch
    - EXPECTED: Approved cleanup record is merged to main with R9/roadmap still explicitly conditional on the exact cleanup main run and terminal comment.
    - COMMAND: gh run view <cleanup-main-run> --json conclusion,headSha,jobs,url plus Release-step output and complete post-run registry/ref comparison
    - EXPECTED: Exact cleanup merge SHA succeeds; published is not true, publishedPackages is empty, GitHub release creation is skipped, and every package version/dist-tag/tag/release equals the pre-merge snapshot.
    - COMMAND: gh pr view <cleanup-pr> --comments
    - EXPECTED: After separately authorized write, the merged PR contains the final terminal evidence comment satisfying the clause; only then treat R9 as VERIFIED, the roadmap as COMPLETE, and report completion without another main push.
  ENABLES: CX-10, CX-10F
```

## Execution Notes

### 2026-07-13 stable publication evidence

- PR #161 reached exact head `c54393e5a7b4ee2932fb7f48e9637f54f04908e0`
  with a successful build, CodeRabbit approval, and zero unresolved review
  threads. It was squash-merged as
  `6760a47ce98dd68ff850cb169261f4b12da5af3d`.
- Main run [29274477315](https://github.com/pydantic/logfire-js/actions/runs/29274477315)
  passed and created Version Packages PR #162 without publishing. Registry
  state remained browser `latest=0.16.4`, replay `latest=0.1.0-alpha.1`, and
  both `alpha` tags were unchanged.
- Version Packages head `ab895956bfb375dd7ba6ce7a8af6e2789f0969e0`
  contained browser `0.17.0`, replay `0.1.0`, and private client `0.1.16` only.
  Its exact detached full check, CodeRabbit review, zero-thread audit, generated
  diff inspection, and workspace artifact/consumer verifier passed. PR #162
  was squash-merged as `1f3b1cbd7b0cc91956dba3c5dad00049dc3969b0`.
- Publication run [29275066883](https://github.com/pydantic/logfire-js/actions/runs/29275066883)
  passed. Its immutable log directly records successful publication of exactly
  `@pydantic/logfire-session-replay@0.1.0` and
  `@pydantic/logfire-browser@0.17.0`; the complete pre/post registry snapshot
  proves every other public package and dist-tag was unchanged.
- The Changesets action did not expose `published=true`, so the workflow's
  GitHub-release step skipped despite the successful publishes. In accordance
  with the runbook recovery clause, the two missing tags/releases were created
  explicitly at publication merge `1f3b1cbd`; both refs resolve directly to
  that commit.
- npm now resolves browser `latest=0.17.0` and replay `latest=0.1.0`; browser
  `alpha=0.17.0-alpha.2` and replay `alpha=0.1.0-alpha.1` remain unchanged. The
  registry artifact verifier passed isolated ESM, CJS, type-only,
  optional-peer, and real-browser consumer checks. Its one-day age policy was
  overridden only for the isolated immediate post-publish check.
- The downstream contract was delivered to
  [Platform PR #25595](https://github.com/pydantic/platform/pull/25595#issuecomment-4961379232)
  with stable versions, page-URL/privacy defaults, replay envelope
  compatibility, the optional peer range, duplicate-bundle limitation, and
  release evidence links.
- Consumer acceptance: `CX-10A`, `CX-10B`, `CX-10C`, and `CX-10` are
  **DIRECTLY VERIFIED**. `CX-10F` is **VERIFIED WITH RECORDED RECOVERY** for the
  skipped GitHub-release step and immediate-registry age-policy exception.
  R9 remains conditional on the cleanup PR, its no-publication main run, and
  its terminal evidence comment.
- Evidence PR #163 was approved at exact head `e10c8d6`, with a successful
  exact-head build and zero unresolved review threads, then squash-merged as
  `f93e28a7fcaa4ffe6e9a6e56a789ae9e120b9910`. Main run
  [29275885492](https://github.com/pydantic/logfire-js/actions/runs/29275885492)
  passed and reported `There are no new packages that should be published`;
  GitHub release creation skipped. The complete registry/dist-tag snapshot and
  both stable release refs were unchanged after the run.
- The remote feature branch `petyosi/browser-rum-alpha-release` was already
  absent when the post-evidence cleanup gate ran, consistent with repository
  automatic branch deletion. Its
  final head `c54393e` and feature squash merge `6760a47c` have the identical
  tree `c574694065bb7c9b6d1739b230c73cc46319e54b`, proving no feature-branch
  content was omitted by squash. Browser `alpha=0.17.0-alpha.2` and replay
  `alpha=0.1.0-alpha.1` remain unchanged.
- A repository-local push mapping unexpectedly sent the first documentation-only
  cleanup commit `38c3b3f` directly to `main`. Exact run
  [29276121713](https://github.com/pydantic/logfire-js/actions/runs/29276121713)
  passed and reported no packages to publish. Approved recovery PR #164 restored
  the pre-cleanup tree as `8986267`; exact run
  [29276457308](https://github.com/pydantic/logfire-js/actions/runs/29276457308)
  also passed with no packages to publish and skipped GitHub release creation.
  No history rewrite or registry/ref mutation was used for recovery.
- This cleanup record deliberately leaves R9 `IN PROGRESS` and the roadmap
  `ACTIVE`. For cleanup PR #165, R9 becomes `VERIFIED` and the roadmap becomes
  `COMPLETE` only after the merged PR's terminal evidence comment records its
  exact successful main run, no published packages, skipped GitHub release
  creation, an unchanged complete registry/ref snapshot, and continued feature
  branch absence.

- Task 1 rehearsal used an exact synthetic commit in a disposable clone so the
  verifier could enforce its clean-live-tree and immutable-ref preconditions
  before the verifier itself existed on the feature branch.
- npm packing and consumer installation use per-run scratch caches. This avoids
  relying on operator-global npm cache ownership or contents while preserving
  real registry and installer behavior.
- Prerelease rehearsal accepts the already-published replay peer range in either
  exact or caret form. Stable verification remains fail-closed on the planned
  `^0.1.0` peer contract.
- Package-name imports cause Vite to prebundle the browser package by default.
  The generated optional-feature fixture excludes that package from dependency
  optimization so its controlled `web-vitals/attribution` alias still observes
  registration without replacing the packed package import.
- The exact rehearsal commit passed workspace pack, manifest/tarball inspection,
  isolated ESM/CJS/type consumers with and without replay, and all four browser
  receipts. Evidence was written outside the repository and is intentionally
  not committed.

## Validation

Execution is deliberately sequential. A later block must not run until the
preceding mutation and its direct evidence are complete.

```bash
# Local immutable candidate gate
pnpm run check
pnpm run verify:browser-rum-release-plan

# GitHub candidate/review gate (after authorized push)
gh pr view 161 --json headRefOid,mergeable,mergeStateStatus,reviewDecision,reviews,statusCheckRollup
python3 <gh-address-comments-skill>/scripts/fetch_comments.py

# Version Packages candidate gate
gh pr view <version-pr> --json headRefOid,baseRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup
gh pr diff <version-pr>
# In a dedicated temporary clone checked out to the exact Version PR head:
python3 <gh-address-comments-skill>/scripts/fetch_comments.py
node scripts/verify-browser-release-artifacts.mjs workspace --ref <version-pr-head-sha> --browser-version 0.17.0 --replay-version 0.1.0 --evidence <scratch-json>

# Public registry gate after authorized Version Packages merge
npm info @pydantic/logfire-browser@0.17.0 version dist.integrity dist.tarball --json
npm dist-tag ls @pydantic/logfire-browser
npm info @pydantic/logfire-session-replay@0.1.0 version dist.integrity dist.tarball --json
npm dist-tag ls @pydantic/logfire-session-replay
node scripts/verify-browser-release-artifacts.mjs registry --browser-version 0.17.0 --replay-version 0.1.0 --evidence <scratch-json>

# GitHub release and ancestry gate
gh release view '@pydantic/logfire-browser@0.17.0'
gh release view '@pydantic/logfire-session-replay@0.1.0'
git merge-base --is-ancestor <feature-head> origin/main
git merge-base --is-ancestor <publication-evidence-commit> origin/main
# After each evidence/cleanup PR merge, inspect its exact main run and compare
# the complete registry/ref snapshot; require no published packages or changes.
```

For each external mutation, show the immediately preceding evidence and obtain
authorization in the active turn. Do not interpret earlier general permission
to generate or execute this PRP as approval for later merge, publish-triggering,
message-send, dist-tag, or deletion operations.

The acceptance table is authoritative. Internal tests support but do not replace
the exact PR head, generated PR, public npm, registry-tarball consumer, GitHub
release, handoff, and branch-state observations.

## Unknowns & Risks

- GitHub/npm state can change after planning. Every external observation must be
  refreshed immediately before its gate.
- The 19 review threads may become outdated after push rather than automatically
  resolved. Outdated is acceptable only when the pushed diff demonstrably
  removes the reported condition; substantive requests still require an explicit
  disposition and cleared review state.
- The repository has no enforced `main` branch protection. A mistaken merge is
  technically possible, so SHA/review/check confirmation and user authorization
  are operational controls.
- The npm publish is irreversible. If the workflow reports success but registry
  state is incomplete or inconsistent, stop and diagnose; do not republish or
  mutate tags speculatively.
- GitHub release creation may be skipped even on a green workflow. Missing
  required stable tags/releases is a failed R9 outcome to repair explicitly,
  not evidence that npm publication failed.
- Scratch browser fixtures must prove they import packed/registry packages, not
  local workspace aliases or source paths; otherwise their evidence is invalid.
- Downstream handoff requires a named destination/acknowledgement at execution
  time. If unavailable, publication can be reported but branch deletion and
  roadmap completion remain blocked.

**Confidence: 9/10** for one-pass execution up to each authorization gate. The
remaining uncertainty is live service/review/credential state, contained by
direct observation and fail-closed checkpoints.
