# @pydantic/logfire-session-replay

## 0.1.0-alpha.1

### Patch Changes

- Publish with package-manager dependency rewriting so npm consumers receive concrete `fflate` and `rrweb` dependency ranges instead of workspace catalog protocol references.

## 0.1.0-alpha.0

### Minor Changes

- 63ccc9d: Add opt-in browser `sessionReplay` integration with SDK-owned session correlation, replay state span attributes, optional peer loading, telemetry endpoint suppression, and live replay mode reporting.
- 98118c3: Add a standalone browser session replay package with rrweb recording, gzip chunk uploads, proxy-first replay transport, direct token escape hatch, privacy defaults, sampling, and trace/session correlation hooks.
