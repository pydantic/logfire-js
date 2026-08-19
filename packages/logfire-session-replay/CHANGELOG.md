# @pydantic/logfire-session-replay

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
