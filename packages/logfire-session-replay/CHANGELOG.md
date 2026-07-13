# @pydantic/logfire-session-replay

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
