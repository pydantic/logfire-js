# Browser RUM + Session Replay Follow-ups

These items were validated during branch review but are better handled as
product/design or robustness follow-ups rather than immediate correctness fixes.

## Experimental Release Posture

Session replay is still behind a Platform feature flag. Keep SDK docs,
examples, release notes, and Platform migration work explicit that replay is
experimental until ingest/playback are generally available. Production adopters
should gate replay independently in their applications.

## Local Development Module Loading

The browser RUM + replay example uncovered two local-only startup traps:

- Privacy extensions or ad blockers can block Vite dev URLs containing
  `session-replay`, causing `ERR_BLOCKED_BY_CLIENT` before replay starts.
- Importing unpublished workspace `dist` output through Vite can resolve rrweb
  to `rrweb.cjs`, which does not provide the named `record` export used by the
  replay package.

The examples now use a neutral `lf-browser-recorder` virtual module and alias
rrweb to `rrweb/dist/rrweb.js`. Keep this note in mind if the workaround is
removed after package publishing changes.

## Privacy and Default Capture Posture

The standalone replay package currently defaults to:

- `sessionSampleRate: 1` and `onErrorSampleRate: 1`
- `captureConsole: true`
- `captureNetwork: true`
- `captureNavigation: true`
- no default `redactUrlPatterns`

This is more aggressive than the README's previous "conservative defaults"
language. Decide whether the shipped browser integration should keep full capture
by default, require explicit capture-class opt-ins, or keep the defaults but make
the docs and examples explicit about URLs, query strings, console output, and
sampling volume.

## Navigation URL Privacy

Custom navigation replay events currently include `window.location.href`.
Network capture has URL redaction and ignore controls; navigation capture does
not. Align navigation with the same URL policy, or document that full navigation
URLs are part of replay capture. Note that rrweb meta events may also contain
page URLs, so custom-event redaction alone does not fully solve URL privacy.

## Web Vitals Reconfiguration Lifecycle

Addressed in this branch: `webVitals.ts` still uses module-level startup state
because the `web-vitals` library registers page-lifecycle observers without a
public unregister API, but the callbacks now read a mutable metric recorder
reference. A later `configure()` call can attach or replace the active recorder
without duplicate observers. Metrics emitted before a recorder exists are not
backfilled.

## Replay Session Expiry During Replay-only Activity

The browser replay integration uses `BrowserSessionManager.peekSessionId()` so
rrweb activity does not perform storage I/O or drive RUM session rotation. This
means replay-only activity with no spans does not enforce idle/max-duration
expiry until a span or explicit `getBrowserSessionId()` touches the session.
This matches the current "spans own RUM session activity" design, but should be
revisited if replay becomes the primary activity signal.

## Hot-path Session Storage I/O

Standalone replay currently calls `SessionManager.touch()` per rrweb event, and
browser span processing calls `BrowserSessionManager.touch()` per span. Both do
synchronous sessionStorage read/parse/write work. This is acceptable for the
first implementation, but an in-memory cache with throttled persistence would
reduce browser main-thread work under high span or rrweb event volume.

## Test Robustness Cleanup

Some tests use short real timers to wait for fire-and-forget async work, and a
few assertions are broader than necessary. Follow-up cleanup could replace
`settle()` sleeps with awaitable flush handles or fake timers, tighten truncation
assertions, and cover cleanup failure precedence and sampling boundary cases.
