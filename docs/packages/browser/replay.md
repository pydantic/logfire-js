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

## Privacy controls

Replay masks all rendered text and input values by default, leaves console
capture off, and removes query strings and fragments from captured page,
fetch/XHR, and navigation URLs. Network and navigation capture remain enabled.
These replay-package defaults are inherited when browser options are omitted.

Use `blockSelector` to omit a subtree. Set `maskAllText: false` only when
visible text recording is acceptable; `maskTextSelector` can then selectively
mask sensitive regions. `captureConsole: true` is an explicit opt-in, and
`redactUrlPatterns: []` explicitly restores raw replay URLs. Text masking does
not scrub DOM attributes, CSS content, resource URLs, or arbitrary custom-event
payloads, so those values still require application-side care.

## Record sessions with errors

Use the [errors and replay profile](errors.md#errors-and-replay-profile) to
buffer a session and upload it when an error occurs. For automatic tracing and
performance data alongside replay, keep the default browser profile.

## Recording identity

`sessionReplay` implies default RUM session behavior. Browser spans keep their
RUM `session.id`. Each tab replay has a separate upload/playback identifier in
`logfire.session_replay.id`. Same-tab reloads and navigations continue that replay;
new tabs start separate replays, even when they share a RUM session. Replays
roll over after at most two hours. Spans started after replay has
loaded and sampled into `full` or `buffer` mode include
`logfire.session_replay.active` and `logfire.session_replay.mode`. Those active
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
reload.

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
