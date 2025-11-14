---
"@pydantic/logfire-node": minor
---

BREAKING CHANGE: Package renamed from `logfire` to `@pydantic/logfire-node`.

This change clarifies that this package is the Node.js-specific SDK with OpenTelemetry auto-instrumentation.

**Migration Guide**:

- Update package.json: Change `"logfire"` to `"@pydantic/logfire-node"`
- Update imports: Change `from 'logfire'` to `from '@pydantic/logfire-node'`
- Run `npm install` to update lockfiles

The package functionality remains identical. This is purely a naming change.

**Why this change?**
The core API package (now simply called `logfire`) is used across all runtimes. The Node.js SDK with auto-instrumentation is a more specialized package and should have a scoped, descriptive name.
