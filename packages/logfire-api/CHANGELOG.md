# @pydantic/logfire-api

## 0.12.0

### Minor Changes

- 56f5bbb: Add `errorFingerprinting` configuration option to control error fingerprint computation

  Error fingerprinting enables grouping similar errors in the Logfire backend. However, minified browser code produces unstable fingerprints because function names are mangled, causing the same logical error to generate different fingerprints across deployments.
  - Added `errorFingerprinting` option to `LogfireApiConfigOptions`
  - Browser SDK now defaults to `errorFingerprinting: false`
  - Node SDK keeps the default `errorFingerprinting: true`
  - Users can override the default in either SDK via the `configure()` options

## 0.11.1

### Patch Changes

- 9f03df2: Fix phantom dependencies

## 0.11.0

### Minor Changes

- 28eb056: BREAKING CHANGE: Package renamed from `@pydantic/logfire-api` to `logfire`.

  This change makes the core API package easier to use with a simpler, unscoped name.

  **Migration Guide**:
  - Update package.json: Change `"@pydantic/logfire-api"` to `"logfire"`
  - Update imports: Change `from '@pydantic/logfire-api'` to `from 'logfire'`
  - Run `npm install` to update lockfiles

  The package functionality remains identical. This is purely a naming change.

  **Why this change?**
  The core API package is used across all runtimes (Node, browser, Cloudflare Workers) and deserves the simpler package name. The Node.js-specific SDK with auto-instrumentation is now `@pydantic/logfire-node`.

## 0.9.0

### Minor Changes

- 03df4fb: Add default export to packages. Using the default import is equivalent to the star import.

## 0.8.2

### Patch Changes

- 8c57b16: Do not format span_name

## 0.8.1

### Patch Changes

- 4c22f71: Externalize the context manager, to avoid zone.js patching

## 0.8.0

### Minor Changes

- f29a18b: Support Zone.js promises

## 0.7.0

### Minor Changes

- 2f2f859: Improve nested span API
  - Add convenient 2 argument overload for `span`.
  - Support `parentSpan` option to nest spans manually.

## 0.6.1

### Patch Changes

- 421b666: Fix async parent span timing

## 0.6.0

### Minor Changes

- 71f46db: Auto-close spans opened with logfire.span

## 0.5.0

### Minor Changes

- 478e045: Experimental browser support

## 0.4.2

### Patch Changes

- fac89ec: logfire.reportError - documentation and setting correct span type
- fac89ec: Document and slightly enhance the `reportError` function.

## 0.4.1

### Patch Changes

- cd2ac40: Fix attribute serialization

## 0.4.0

### Minor Changes

- dc0a537: Support for EU tokens. Support span message formatting.

## 0.3.0

### Minor Changes

- 6fa1410: API updates, fixes for span kind

## 0.2.1

### Patch Changes

- 838ba5d: Fix packages publish settings.

## 0.2.0

### Minor Changes

- 0f0ce8f: Initial release.
