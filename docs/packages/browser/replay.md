---
title: Session replay
description: Record browser sessions, choose privacy settings, and handle replay lifecycle and uploads.
---

# Session replay

Session replay is available to Logfire Early Access organizations. Keep replay
behind your own application flag and expect minor API, ingest, and UI behavior
changes before Beta.

> **Early Access pricing:** Session replay is free during Early Access. Pricing
> has not been announced and will be published before General Availability
> (GA). Session replay will become a paid feature in a later release.

Install the optional replay package:

```bash
npm install @pydantic/logfire-session-replay
```

Pass the replay integration to `configureFrontend()`. The integration
keeps the recorder out of the initial application bundle:

```ts
import * as logfire from '@pydantic/logfire-browser'
import { sessionReplayIntegration } from '@pydantic/logfire-session-replay/integration'

const cleanup = logfire.configureFrontend({
  baseUrl: 'https://logfire-us.pydantic.dev',
  token: '<frontend-application-token>',
  sessionReplay: sessionReplayIntegration(),
})
```

## Sampling

By default, replay records one session in ten in full (`sessionSampleRate: 0.1`).
It buffers every other session in memory and uploads it only if an error occurs
(`onErrorSampleRate: 1`). Each uploaded recording counts toward your replay
usage, so choose the full-session rate from your traffic:

| Sessions per day  | `sessionSampleRate` |
| ----------------- | ------------------- |
| Fewer than 10,000 | `0.25`              |
| 10,000 to 100,000 | `0.1`               |
| More than 100,000 | `0.01`              |

Record every session in development:

```ts
logfire.configureFrontend({
  baseUrl: 'https://logfire-us.pydantic.dev',
  token: '<frontend-application-token>',
  sessionReplay: sessionReplayIntegration({
    sessionSampleRate: location.hostname === 'localhost' ? 1 : 0.1,
  }),
})
```

## Privacy controls

Replay masks all rendered text and input values by default, leaves console
capture off, and removes query strings and fragments from captured page,
fetch/XHR, and navigation URLs, from DOM URL attributes such as `href`, `src`,
and `srcset`, and from the URLs in error messages, sources, and stacks and in
console arguments. URLs with an opaque scheme, such as `mailto:` and `data:`,
keep only the scheme. Inline styles that could reference a URL (through `url`,
`image-set`, `src(`, or a CSS escape) are removed whole, so such elements can
lose background images or other styling in replays. Error messages and stacks are
limited to 1,024 and 8,192 characters. Network and navigation capture remain
enabled. These replay-package defaults are inherited when browser options are
omitted.

Input masking also covers hidden inputs. Text masking also covers the
text-bearing attributes `title`, `alt`, `aria-label`, `placeholder`, and
similar, button labels set through `value`, and `data-*` attributes. UI state
and theme attributes such as `data-state`, `data-orientation`, and `data-theme`,
and `data-*` values that are empty, `true`, or `false`, are kept so that open
menus, selected items, and themes replay as the user saw them.

Use `blockSelector` to omit a subtree. Set `maskAllText: false` only when
visible text recording is acceptable; `maskTextSelector` can then selectively
mask sensitive text, but it does not mask attributes. `captureConsole: true` is
an explicit opt-in, and `redactUrlPatterns: []` explicitly restores raw replay
URLs. Masking does not scrub other DOM attributes, stylesheet content, or
arbitrary custom-event payloads, so those values still require
application-side care.

Paths can also carry private values, such as reset tokens or email addresses.
Use `transformUrl` to rewrite each page, navigation, network, and DOM attribute
URL after the built-in redaction. The rewritten URLs are also the ones replay
search shows. URLs inside error messages, stacks, and console arguments keep
the built-in redaction only.

```ts
const cleanup = logfire.configureFrontend({
  baseUrl: 'https://logfire-us.pydantic.dev',
  token: '<frontend-application-token>',
  sessionReplay: sessionReplayIntegration({
    transformUrl: (url) => url.replace(/\/reset-password\/[^/]+/u, '/reset-password/:token'),
  }),
})
```

## Record sessions with errors

Use the [errors and replay profile](errors.md#errors-and-replay-profile) to
buffer a session and upload it when an error occurs. For automatic tracing and
performance data alongside replay, keep the default browser profile.

## Recording identity

`sessionReplay` implies default RUM session behavior. Browser spans keep their
RUM `session.id`. Each tab replay has a separate upload/playback identifier in
`logfire.session_replay.id`. Same-tab reloads and navigations continue that replay;
new tabs start separate replays, even when they share a RUM session. Replays
roll over after at most two hours, and with the RUM session after its idle
timeout. Spans started while replay records in `buffer` mode, or in `full` mode
once it has passed its minimum duration and uploads, include
`logfire.session_replay.active` and `logfire.session_replay.mode`. Spans from a
visit that ends before the minimum duration are not marked, because that visit
uploads no replay. Those active
attributes are truthful best-effort annotations. Link a marked span to its
recording using `logfire.session_replay.id`, falling back to `session.id` for
older SDK recordings. Spans emitted before replay startup do not have a recording
link. Replay chunks do not include per-trace correlation metadata.

The standalone recorder's `getSessionId()` still returns its RUM session.
Use `getRecordingId()` for its current upload/playback ID; it returns an empty
string when no recorder is active or during a session transition. Deploy Platform
support for this attribute before upgrading the SDK.

New tabs count as separate billable replays; same-tab reloads do not. If browser
storage is unavailable or its saved sequence cannot be safely resumed, the SDK
starts a new replay rather than risking a sequence collision. Upgrade both
`@pydantic/logfire-browser` and `@pydantic/logfire-session-replay` together so
browser spans carry the new recording link.

Browser-session inactivity currently means span inactivity: replay startup
initializes and touches the session once before loading the recorder, but
subsequent replay events only peek at the session id and do not refresh the
timeout. Span starts are the ongoing automatic activity;
`getBrowserSessionId()` also explicitly touches the session.

## Identify users

Each replay chunk snapshots `rum.session.getUser()` once and reports its `id`,
`name`, and `email` as `meta.user`, so recordings can be displayed and searched
by the same user as spans. Name and email are optional personal data; omit
them from `getUser` unless replay viewers need them. Other fields of the
returned object are not sent, and the user is never written to rrweb events or
`sessionStorage`. `meta.user` is omitted when `getUser` is not configured,
returns no user, or throws, and later chunks follow login, logout, and user
switches.

When `sessionReplay.getDistinctId` is not configured, replay uses the same
snapshot's `id` as `meta.distinctId`, so replay rows and span `user.id` agree.
An explicit `getDistinctId` remains authoritative, and `distinctId` and
`user.id` are then reported independently. A static `sessionReplay.distinctId`
remains the fallback while the selected live getter returns `undefined`.

See [Routes, users, and sessions](identity.md) to configure `getUser` and session attributes.

## Flush and stop

Use the cleanup handle returned by configuration when you need to flush or stop
recording. Keep it separate from application startup.

Replays shorter than `minSessionDurationMs` are not uploaded (10 seconds by
default). An earlier flush remains buffered until the minimum is reached, and
stopping earlier discards the replay. Set `minSessionDurationMs: 0` only when
shorter replays must be delivered.

```ts
// The property exists synchronously whenever sessionReplay is configured.
await cleanup.sessionReplay?.flush()
await cleanup.sessionReplay?.stop() // replay only; tracing remains active
await cleanup() // full SDK cleanup
```

Before lazy replay startup completes, after startup failure, and after replay is
stopped, the facade reports `mode: 'off'` and `recording: false`. Its `stop()`
method is idempotent and generation-scoped. Session identity remains available
through `getBrowserSessionId()`, not the replay facade.

## Uploads and limits

After a replay reaches the minimum duration, hiding the document or receiving
`pagehide` makes a bounded best-effort start of the earliest compressed chunks.
Its 48,000-byte aggregate
budget is shared across its own unfinished keepalive requests, while the
browser's keepalive quota is also shared with unrelated page traffic. Delivery
after page freeze or termination is therefore not guaranteed. Functional
`headers` and `token` values are resolved for every upload; an asynchronous
resolver can finish too late for a lifecycle request. The generated frontend
application headers are synchronous and work for these uploads.

Ordinary replay uploads automatically fall back to synchronous gzip if a
restrictive Content Security Policy blocks the compressor worker. The fallback
preserves the batch and is remembered for the active replay controller, but it
may briefly use the main thread.

Ordinary replay uploads are retried with the same sequence number and bytes for
up to 30 seconds per chunk after network errors, timeouts, `408`, `425`, `429`,
and `5xx` responses. The in-memory queue holds at most about 2 MB. When a chunk
is still lost, `sessionReplay.onError` receives a `ReplayUploadError` with the
lost `seq`, the dependent `droppedSeqs`, and a `reason` of `unconfirmed`,
`rejected`, or `not-sent`. Replay then takes a fresh full snapshot so playback
resumes correctly after the gap. Queued chunks do not survive a page close or
reload. A `4xx` rejection other than `408`, `413`, `425`, or `429`, such as a
revoked token or a usage block, stops replay for the page instead: the recorder
detaches and the facade reports `recording: false`.

For a separate replay destination or an authenticated proxy, see
[Advanced configuration](advanced.md#separate-replay-destination).
Recording ownership and storage fallback behavior are covered in
[Recording ownership](advanced.md#recording-ownership).

## Troubleshooting

When testing replay locally, browser privacy extensions or ad blockers may block
requests or dynamic imports whose URLs contain terms such as `session-replay`.
If replay fails to start with `ERR_BLOCKED_BY_CLIENT`, test in a clean profile
or disable the extension for the local app. Vite workspace examples may also
need to load `@rrweb/record`'s browser ESM build
(`@rrweb/record/dist/record.js`) rather than its CommonJS build when importing
unpublished workspace output directly.

To find and inspect recordings, see the [Session Replays guide](https://pydantic.dev/docs/logfire/observe/session-replays/).
