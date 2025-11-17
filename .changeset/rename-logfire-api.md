---
"logfire": minor
---

BREAKING CHANGE: Package renamed from `@pydantic/logfire-api` to `logfire`.

This change makes the core API package easier to use with a simpler, unscoped name.

**Migration Guide**:

- Update package.json: Change `"@pydantic/logfire-api"` to `"logfire"`
- Update imports: Change `from '@pydantic/logfire-api'` to `from 'logfire'`
- Run `npm install` to update lockfiles

The package functionality remains identical. This is purely a naming change.

**Why this change?**
The core API package is used across all runtimes (Node, browser, Cloudflare Workers) and deserves the simpler package name. The Node.js-specific SDK with auto-instrumentation is now `@pydantic/logfire-node`.
