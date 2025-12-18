# logfire

## 0.11.3

### Patch Changes

- 9f03df2: Fix phantom dependencies
- Updated dependencies [9f03df2]
  - logfire@0.11.1

## 0.11.2

### Patch Changes

- 79032ef: Fix Scrubbing configuration. Scrubbing now works even when scope is not set

## 0.11.1

### Patch Changes

- 26db714: Fix publish

## 0.11.0

### Minor Changes

- 28eb056: BREAKING CHANGE: Package renamed from `logfire` to `@pydantic/logfire-node`.

  This change clarifies that this package is the Node.js-specific SDK with OpenTelemetry auto-instrumentation.

  **Migration Guide**:

  - Update package.json: Change `"logfire"` to `"@pydantic/logfire-node"`
  - Update imports: Change `from 'logfire'` to `from '@pydantic/logfire-node'`
  - Run `npm install` to update lockfiles

  The package functionality remains identical. This is purely a naming change.

  **Why this change?**
  The core API package (now simply called `logfire`) is used across all runtimes. The Node.js SDK with auto-instrumentation is a more specialized package and should have a scoped, descriptive name.

### Patch Changes

- Updated dependencies [28eb056]
  - logfire@0.11.0

## 0.10.0

### Minor Changes

- 03df4fb: Add default export to packages. Using the default import is equivalent to the star import.

### Patch Changes

- Updated dependencies [03df4fb]
  - @pydantic/logfire-api@0.9.0

## 0.9.1

### Patch Changes

- 258969c: Update READMEs

## 0.9.0

### Minor Changes

- 413ff56: Support logging spans in the console

## 0.8.0

### Minor Changes

- 71f46db: Auto-close spans opened with logfire.span

### Patch Changes

- Updated dependencies [71f46db]
  - @pydantic/logfire-api@0.6.0

## 0.7.0

### Minor Changes

- 2a62de6: Support passing additional instrumentations

## 0.6.0

### Minor Changes

- 478e045: Experimental browser support

### Patch Changes

- Updated dependencies [478e045]
  - @pydantic/logfire-api@0.5.0

## 0.5.2

### Patch Changes

- cd2ac40: Fix attribute serialization
- Updated dependencies [cd2ac40]
  - @pydantic/logfire-api@0.4.1

## 0.5.1

### Patch Changes

- 14833ef: Fix typo in interface name

## 0.5.0

### Minor Changes

- e1dc8d0: Allow configuration of node auto instrumentations

## 0.4.1

### Patch Changes

- 8dbb603: Fix for not picking up environment

## 0.4.0

### Minor Changes

- dc0a537: Support for EU tokens. Support span message formatting.
- 65274e3: Support us/eu tokens

### Patch Changes

- Updated dependencies [dc0a537]
  - @pydantic/logfire-api@0.4.0

## 0.3.0

### Minor Changes

- 6fa1410: API updates, fixes for span kind

### Patch Changes

- Updated dependencies [6fa1410]
  - @pydantic/logfire-api@0.3.0

## 0.2.2

### Patch Changes

- a391811: Fix for a peer package

## 0.2.1

### Patch Changes

- 838ba5d: Fix packages publish settings.
- Updated dependencies [838ba5d]
  - @pydantic/logfire-api@0.2.1

## 0.2.0

### Minor Changes

- 0f0ce8f: Initial release.

### Patch Changes

- Updated dependencies [0f0ce8f]
  - @pydantic/logfire-api@0.2.0
