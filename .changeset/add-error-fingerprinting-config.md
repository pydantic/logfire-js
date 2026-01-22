---
"logfire": minor
"@pydantic/logfire-browser": minor
"@pydantic/logfire-node": minor
---

Add `errorFingerprinting` configuration option to control error fingerprint computation

Error fingerprinting enables grouping similar errors in the Logfire backend. However, minified browser code produces unstable fingerprints because function names are mangled, causing the same logical error to generate different fingerprints across deployments.

- Added `errorFingerprinting` option to `LogfireApiConfigOptions`
- Browser SDK now defaults to `errorFingerprinting: false`
- Node SDK keeps the default `errorFingerprinting: true`
- Users can override the default in either SDK via the `configure()` options
