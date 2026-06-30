# Code Review - Browser RUM and Session Replay

## Review Context

- Branch: `petyosi/browser-rum-web-vitals`
- Base: `origin/main`
- Date: 2026-06-30
- Scope: current branch diff, 59 files changed
- Method: local code-review pass over browser RUM, Web Vitals, session replay, transport, monkey-patching, docs, and examples
- Validation run: `git diff --check origin/main...HEAD`; direct package build for session replay bundling verification with `vp run @pydantic/logfire-session-replay#build`

Subagents were not used because they were not explicitly authorized for this review.

## Findings Summary

| Severity   | Confidence | Finding                                                                                 | Location                                                                                                                                                       |
| ---------- | ---------: | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High       |         90 | Replay capture can throw into host app fetch, XHR, and navigation paths                 | `packages/logfire-session-replay/src/capture.ts:76`, `:117`, `:206`                                                                                            |
| Medium     |         80 | Explicit replay stop uses `keepalive` for the final flush, risking dropped large chunks | `packages/logfire-session-replay/src/index.ts:157`, `packages/logfire-session-replay/src/transport.ts:161`, `packages/logfire-session-replay/src/types.ts:176` |
| Medium-Low |         75 | Public docs are stale or inconsistent for replay integration and cleanup                | `packages/logfire-session-replay/README.md:119`, `packages/logfire-browser/README.md:315`, `docs/packages/browser.md:391`                                      |

## 1. Replay Capture Can Throw Into Host App Paths

Score: 90

The capture wrappers call `emit(...)` directly from patched host APIs:

- `fetch` success and failure paths
- `XMLHttpRequest` completion
- `history.pushState` and `history.replaceState`

If rrweb `addCustomEvent`, or any later custom emitter path, throws while recording a network or navigation event, the exception escapes into the application operation being observed. That can turn a successful `fetch()` into a rejected promise, replace the original fetch error with an instrumentation error, or make `pushState`/`replaceState` throw after the native history change has already happened.

`captureConsole` already protects the app by catching instrumentation failures and reporting through `onError`, so the network and navigation wrappers should use the same failure boundary.

Suggested fix:

- Add a small `safeEmit` helper in `capture.ts`.
- Catch emitter exceptions and report them through the existing `onError` callback.
- Use `safeEmit` for fetch, XHR, and navigation capture paths.

Suggested tests:

- Fetch success still resolves when `emit` throws.
- Fetch failure still rejects with the original fetch error when `emit` throws.
- XHR completion does not throw through user event handlers when `emit` throws.
- `pushState` and `replaceState` do not throw when event emission fails.

## 2. Final Replay Flush Always Uses Keepalive

Score: 80

`stop()` currently shuts down the replay transport with `keepalive: true`. The transport then sends the final replay upload through a keepalive request path. Browser keepalive uploads have small payload constraints, while the replay buffer defaults to `maxBufferBytes: 1_000_000`.

That means an explicit user-controlled `stop()` can silently drop the final replay chunk when the pending payload is larger than the browser's keepalive limit. This is especially likely after a busy session or if the app stops replay after accumulating a large buffer.

Suggested fix:

- Reserve `keepalive` for page lifecycle exits such as `pagehide` or visibility-driven finalization.
- Let explicit `stop()` use a normal non-keepalive flush when the page is still alive.
- If keepalive must be used, cap or split payloads before attempting the final upload and surface/report the dropped remainder.

Suggested tests:

- Explicit `stop()` flushes with `keepalive: false` or otherwise avoids keepalive payload limits.
- Page lifecycle shutdown still uses keepalive.
- Oversized keepalive payload behavior is deterministic and reported through `onError` or another observable path.

## 3. Public Docs Are Stale Or Inconsistent

Score: 75

Several docs do not match the branch behavior:

- `packages/logfire-session-replay/README.md` still presents browser-package integration as a future follow-up and tells users to call `startSessionReplay()` directly.
- `packages/logfire-browser/README.md` cleanup guidance stops the browser client but does not mention replay cleanup.
- `docs/packages/browser.md` also omits replay cleanup, and its cleanup example does not include metrics cleanup either.

This increases the chance that users either follow the lower-level standalone API accidentally or leave replay/metrics resources running after shutdown.

Suggested fix:

- Update the standalone session replay README to describe current integration with `@pydantic/logfire-browser`.
- Keep direct `startSessionReplay()` usage documented only as an advanced or standalone path.
- Align cleanup examples across package README and docs site so they cover browser client, metrics, and replay lifecycles consistently.

Suggested tests/checks:

- No runtime test required, but docs examples should be checked against exported public APIs.
- If docs snippets are covered by a documentation test/lint path, include these examples there.

## Verified False / Not A Finding

### External replay dependencies are not bundled into the package dist

An earlier concern was that the new replay package might bundle external dependencies into its published output. I verified this is not the case.

After running:

```bash
vp run @pydantic/logfire-session-replay#build
```

the generated package output still leaves both external dependencies as runtime package imports:

- `dist/index.js` imports `rrweb` and `fflate`
- `dist/index.cjs` requires `rrweb` and `fflate`

So the standalone `@pydantic/logfire-session-replay` package does not inline those packages into its own dist output. Applications that opt into replay will still bundle or load those dependencies through their application bundler. This should not be treated as a PR blocker.

## Excluded From Review

The following untracked files were present and were not treated as part of the branch diff unless they are intentionally added to the PR:

- `docs/session-replay-integration.md`
- `reports/plan-review-024-browser-session-replay-integration.md`

I did not run the full workspace test suite or full check command during the review. The only validation run during review was whitespace checking, plus the focused session replay package build used to verify the bundling question.

## Verdict

There are three actionable findings. The most important one is the replay capture exception boundary because it can make passive instrumentation change application behavior. The keepalive shutdown behavior is the next highest risk because it can lose replay data at the point users expect a final flush. The docs issue should be resolved before publishing or opening a user-facing PR.
