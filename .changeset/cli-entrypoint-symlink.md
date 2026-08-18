---
'logfire': patch
---

Run the `logfire` CLI when the bin is invoked through a symlink. The entrypoint check compared `import.meta.url` against `process.argv[1]` verbatim, but Node resolves the module URL to the real path while leaving `argv[1]` as the literal invocation path. Any symlink between the two made the check fail, so the command exited 0 without printing anything and without running. `argv[1]` is now resolved before the comparison.

This affected every install whose invocation path crossed a symlink: `npm install` and Yarn, where the bin itself is a symlink; pnpm with `node-linker=hoisted`; and pnpm workspace links, where the shim points through a symlinked package directory. Only pnpm's default isolated layout and `pnpm add -g` escaped, because their shims target the physical path.
