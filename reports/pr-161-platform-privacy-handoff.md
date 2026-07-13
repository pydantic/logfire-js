# PR 161 Platform privacy-contract handoff

This is the exact amendment to apply to the adjacent Platform follow-up report
in a separately authorized Platform task. It records the stable browser SDK
contract after the privacy-default work; it does not claim that Platform code
has already changed.

## Stable page attributes

The browser SDK now emits page attributes without a query string or fragment by
default. For a page such as
`https://shop.example/products/42?token=secret#reviews`, the stable values are:

```text
logfire.page.url.full = https://shop.example/products/42
logfire.page.url.path = /products/42
```

Applications may explicitly return `url.href` from `rum.session.urlAttributes`
to restore the raw page URL, or set `urlAttributes: false` to suppress page URL
attributes.

Platform's page-URL callback or normalization should remain as defense in depth
for new SDK data, not be described as the sole sanitizer. Keep the legacy
fallback for older SDK payloads and manually produced telemetry that may still
contain query strings or fragments.

Page attributes and network request attributes remain separate contracts.
`logfire.page.url.*` describes current-page context. OpenTelemetry network spans
may independently carry request-target `url.*` values and must continue through
the Platform's network-specific privacy and presentation handling.

## Replay contract

The replay SDK now masks rendered text and input values, disables console
capture, and removes query strings and fragments from captured page,
network, and navigation URLs by default. Explicit application opt-ins can
restore visible text (`maskAllText: false`), console events
(`captureConsole: true`), or raw replay URLs (`redactUrlPatterns: []`). DOM
attributes, CSS content, resource URLs, and arbitrary custom-event payloads are
not covered by text masking and should not be represented as scrubbed.

Update the existing adjacent Platform report with these examples and caveats;
retain its legacy-data and page-versus-network handling recommendations.
