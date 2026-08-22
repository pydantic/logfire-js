# Contributing to the Pydantic Logfire JavaScript SDK - instructions

1. Fork and clone the repository.
2. Run `pnpm install`.
3. Start the relevant example from `examples` and modify it accordingly to illustrate the change/feature you're working on.
4. Modify the package(s) source code located in `packages`, run `pnpm run build` to rebuild.
5. Commit your changes and push to your fork.
6. Submit a pull request.

You're now set up to start contributing!

## Session replay browser tests

Install Chromium once, build the packages, and run the browser acceptance suite:

```bash
vp exec --filter @pydantic/logfire-session-replay -- playwright install chromium
pnpm run build
pnpm run test:browser
```
