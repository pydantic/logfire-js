# @pydantic/logfire-session-replay

## 0.10.0

### Minor Changes

- 60f72af: Record one session in ten by default instead of every session, so replay usage and the privacy exposure stay proportionate when a rate is not chosen.
  
  - **Behavior change:** `sessionSampleRate` now defaults to `0.1` (was `1`). `onErrorSampleRate` stays `1`, so every other session is buffered and uploaded if an error occurs. Before, the error buffer never applied, because every session was already recorded in full. To keep recording every session, set `sessionSampleRate: 1`.
  - The replay docs now recommend a rate for each traffic level and show how to record every session in development.

## 0.9.1

### Patch Changes

- 5ce9e62: Keep errors from page nodes that the page script cannot access out of the application's global error handler.
  
  In Firefox, a node that the page script cannot access, such as one a browser extension inserted, throws `Permission denied to access property "..."` when it is read. Session replay could throw `Permission denied to access property "nodeType"` from rrweb's mutation handling on every DOM change, and the click instrumentation could throw `Permission denied to access property "localName"` when it built the target's XPath. Both reached `window.onerror`.
  
  - Session replay now registers an rrweb error handler. rrweb drops errors from its observer callbacks and keeps recording, and the `onError` option receives each distinct message once.
  - The browser SDK skips the span for an interaction whose target the instrumentation cannot read, and logs one diagnostic warning.

## 0.9.0

### Minor Changes

- b52cc46: Stop session replay when uploads can no longer succeed, and link spans only to replays that exist.
  
  - After a `4xx` rejection that every later chunk would also get (other than `408`, `413`, `425`, and `429`), such as a revoked token or a usage block (`401`, `402`, `403`), replay stops and detaches the recorder. Before, each tab serialized a full DOM snapshot for another rejected upload about once a minute until it closed.
  - Browser replay now follows the RUM session's idle timeout, so a tab that goes idle starts a new replay with its new RUM session.
  - The replay handle has a new `uploading` getter. The browser SDK marks spans with `logfire.session_replay.mode: 'full'` only once the recording passes its minimum duration and uploads, so visits that end earlier no longer point at replays that were never uploaded.

## 0.8.0

### Minor Changes

- 19ea2d8: Give session replay more control over the URLs and page text it records.
  
  The new `transformUrl` option rewrites each replay page, navigation, network, and DOM attribute URL after query and fragment removal, so applications can replace tokens or email addresses in paths. The rewritten URLs are also the ones replay search shows. `@pydantic/logfire-browser` forwards the option from `sessionReplay`.
  
  URL redaction now also covers the `srcset`, `imagesrcset`, `poster`, `data`, `xlink:href`, `background`, and `cite` attributes. Inline styles that could reference a URL, through `url`, `image-set`, `src(`, or a CSS escape, are removed whole, so such elements can lose background images or other styling in replays. URLs with an opaque scheme, such as `mailto:`, `tel:`, `data:`, and `blob:`, now keep only the scheme instead of their content.
  
  `maskAllInputs` now masks hidden input values. `maskAllText` now masks the text-bearing attributes `title`, `alt`, `aria-label`, `placeholder`, and similar, button labels set through `value`, and `data-*` attributes, except common UI state and theme attributes such as `data-state` and `data-theme` and the values `true` and `false`. Replay error messages and stacks are limited to 1,024 and 8,192 characters.

## 0.7.2

### Patch Changes

- 93e84cf: Apply scrubbing to every exported span, not only to the attributes passed to `logfire.span`, `logfire.info`, and the other API helpers. Spans from automatic instrumentation, attributes set after a span starts, span event attributes, span link attributes, span status messages, and Node.js log records are now scrubbed before export. Cloudflare Workers tail mode (`instrumentTail`) now scrubs too and accepts the `scrubbing` option.
  
  Exception messages are now scrubbed consistently. Before, the `exception.message` attribute could be redacted while the same message stayed in the exception event, the span status, and the first line of the stack trace. The message and `Caused by` lines of `exception.stacktrace` are now scrubbed too; stack frame lines are kept.
  
  In the browser, values of custom session attributes (`logfire.session.*`) are scrubbed too, matching only the application's own attribute name against the patterns. `configureFrontend` now removes query strings and fragments from every attribute whose key ends in `.url` (such as `web_vital.lcp.url`) and from the URLs in exception stack traces. Session replay applies `redactUrlPatterns` to error messages, sources, and stacks, and to console arguments, and `sessionReplay.captureGlobalErrors` is passed to the replay recorder when browser global error capture is off.

## 0.7.1

### Patch Changes

- 2ebfe0a: Serialize and retry hidden-tab replay uploads in keepalive-sized chunks, pack page-close chunks into the keepalive budget by compressed size, and export structured replay upload failures through the browser SDK.
- 8a7e6da: Wait for the outgoing replay writer before restoring a cached page, preserving its recording ID and latest chunk sequence.

## 0.7.0

### Minor Changes

- dfd8b27: Let one document at a time write a session replay recording. A duplicated tab could continue another tab's recording and upload different events under the same sequence numbers, which the Platform rejects, so the recording lost events. A document now uploads under a recording only while it holds that recording's Web Lock, and continues from the sequence that a record shared through `localStorage` confirms. A copy whose recording another tab holds starts a new recording after up to one second. Recording still starts at once. Until a continued recording's lock is granted, `getRecordingId()` returns an empty string and spans have no recording link. The lock is released at `pagehide`, so pages stay eligible for the back-forward cache. Browsers without Web Locks or writable `localStorage` keep the previous behavior.

## 0.6.0

### Minor Changes

- cc4c206: Take full-DOM checkpoints every five minutes during normal recording, or at the configured minimum session duration when longer. Start each checkpoint in a new upload chunk so replay viewers can load and seek through smaller playback windows. Error-buffered recording keeps its existing two-minute checkpoint interval.
- f2e4bc5: Give each tab replay an upload/playback ID distinct from its RUM session ID. Preserve it across same-tab reloads and navigations, but start a new replay for another tab or after two hours. Add `getRecordingId()` to the standalone recorder and `logfire.session_replay.id` to browser spans. Start a new replay when its saved sequence cannot be safely resumed.
  
  Requires Platform compatibility readers before upgrading. New tabs produce separate billable replays; same-tab reloads continue the existing replay. The RUM `session.id` attribute and `getSessionId()` remain unchanged; standalone callers linking to playback must use `getRecordingId()`.
- 9b493c5: Let a handled error promote an error-buffered replay. `replay.captureError(error)` adds the error to the replay and promotes the buffer, as an uncaught error does. An error object is added once, even when it is captured and later also uncaught. `captureError(error, { timestamp })` records when an error that is captured later occurred. `captureGlobalErrors: false` removes the replay's own `error` and `unhandledrejection` listeners for integrations that capture global errors themselves, as `@pydantic/logfire-browser` now does. An error event in the replay no longer serializes an object value, such as an object passed to `captureError()` or a rejected object, because replay custom events are not masked; it records only the value's type, such as `[object Object]`.
- 1c7f0e7: Rotate browser and standalone replay session IDs after two hours of active recording by default, instead of four hours. Browser telemetry and integrated replay keep the same session ID when they rotate.
  
  Applications that configure a custom maximum duration retain that setting.

## 0.5.0

### Minor Changes

- f9b75ca: Keep session replays playable after upload failures. Ordinary chunks now wait in a bounded in-memory queue and are retried with the same sequence number and bytes for up to 30 seconds, including after `408`, `425`, `429`, and `5xx` responses. A chunk that is still lost is reported to `onError` as a new `ReplayUploadError` with its `seq`, the `droppedSeqs` that depended on it, and a `reason`. Replay then takes a fresh full snapshot, so later events replay correctly instead of applying to DOM state the server never received. `stop()` now resolves within about 10 seconds, even when uploads hang.

## 0.4.0

### Minor Changes

- 8cd4707: Include the reported user in session replay chunk metadata. Browser spans already carried `user.id`, `user.name`, and `user.email` from `rum.session.getUser()`, but replay chunks carried only `distinctId`, so a replay service could not show who a recording belongs to or find it by email. Each chunk now snapshots the user once into an optional `meta.user` with only `id`, `name`, and `email`, and derives `distinctId` from that same snapshot unless `sessionReplay.getDistinctId` overrides it. Standalone replay users can pass the new `getUser` option.

## 0.3.5

### Patch Changes

- 3d50cfd: Increase the default minimum session replay duration from five to ten seconds.
- 72ee7e1: Add `configureFrontend()` to configure browser tracing, Web Vitals metrics, and optional session replay with one restricted token and regional URL. Auto-instrumentation and Web Vitals metrics are enabled by default, with capture options remaining customizable. Standard instrumentation URL attributes omit query strings, fragments, and URL credentials by default; full URLs require an explicit opt-in. The optional replay package now provides `sessionReplayIntegration()` to lazy-load the recorder without requiring applications to write their own dynamic import.

## 0.3.4

### Patch Changes

- 1d5fd32: Enforce the configured minimum against recorded event duration without letting the initial replay buffer grow unbounded.

## 0.3.3

### Patch Changes

- 5a52742: Define session attributes as own properties so a prototype-named key can never run an inherited setter, independent of the key-pattern guard in front of the write.

## 0.3.2

### Patch Changes

- 118b480: Reduce session replay recording and upload overhead by slowing background event
  uploads to one minute after 30 seconds of inactivity, then five minutes after
  five minutes of inactivity. Omit nonvisual DOM metadata and sample pointer and
  scroll activity less frequently. Do not upload replay sessions that rotate
  during inactivity unless an error or later user interaction makes them useful.
  Discard replay sessions shorter than five seconds by default. Use the dedicated
  `@rrweb/record` package for recording.

## 0.3.1

### Patch Changes

- 5c2bd73: Stop a truncated console argument ending in a lone surrogate. Capture cut arguments on UTF-16 code units, so an astral character straddling the limit kept only its high half, leaving text that is not valid UTF-8 once the replay event is sent. The whole character is dropped instead, and the omitted-character count stays accurate.

## 0.3.0

### Minor Changes

- 28a13c0: Remove the experimental `getTraceContext` option and `meta.traceIds` chunk field. Correlate recordings with browser spans through their shared browser session id and replay time bounds.

## 0.2.0

### Minor Changes

- 531fced: Add per-span route names and bounded, per-session custom RUM dimensions to browser spans and session replay metadata.

## 0.1.0

### Minor Changes

- 6760a47: Add opt-in browser `sessionReplay` integration with SDK-owned session correlation, replay state span attributes, optional peer loading, telemetry endpoint suppression, and live replay mode reporting.
- 6760a47: Add a standalone browser session replay package with rrweb recording, gzip chunk uploads, proxy-first replay transport, direct token escape hatch, privacy defaults, sampling, and trace/session correlation hooks.

### Patch Changes

- 6760a47: Preserve callable browser cleanup while exposing generation-scoped session replay lifecycle controls, keep Web Vitals spans available when metrics startup fails, and mark Web Vitals point events as Logfire logs.

  Remove unused pre-stable replay transport, recorder snapshot, and navigation `load` surfaces that were never used or emitted.

- 6760a47: Use privacy-safe browser defaults: omit query strings and fragments from page
  attributes and replay URLs, mask rendered replay text, and disable replay
  console capture unless explicitly enabled.
- 6760a47: Make replay delivery more reliable with bounded concurrent lifecycle uploads,
  CSP-safe compression fallback, `Retry-After` handling, and UTF-8 byte accounting.
- 6760a47: Harden browser RUM and session replay for their stable releases with transactional replay lifecycle handling, per-session sampling, retry-safe optional instrumentation, and finalized page URL and error-promotion contracts.

## 0.1.0-alpha.1

### Patch Changes

- Publish with package-manager dependency rewriting so npm consumers receive concrete `fflate` and `rrweb` dependency ranges instead of workspace catalog protocol references.

## 0.1.0-alpha.0

### Minor Changes

- 63ccc9d: Add opt-in browser `sessionReplay` integration with SDK-owned session correlation, replay state span attributes, optional peer loading, telemetry endpoint suppression, and live replay mode reporting.
- 98118c3: Add a standalone browser session replay package with rrweb recording, gzip chunk uploads, proxy-first replay transport, direct token escape hatch, privacy defaults, sampling, and trace/session correlation hooks.
