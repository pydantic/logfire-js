---
'logfire': patch
---

Run the CLI when it is invoked through the npm bin symlink. The entry-point guard compared `import.meta.url` against `process.argv[1]`, which never match when npm installs the bin as a symlink, so `npx logfire auth` exited 0 without doing anything.
