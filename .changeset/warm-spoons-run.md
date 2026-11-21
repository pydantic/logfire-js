---
'logfire': minor
---

Replace the JavaScript CLI with the native Logfire CLI. Keep using `npx logfire`, but update scripts that use the old commands: `projects use/new` becomes `init use/new --name`, `projects list` becomes `mcp projects`, `clean` becomes `project clean`, and `read-tokens create` becomes `token read` for the connected project. There is no `--save` option or exact replacement for `projects status`. Run `npx logfire auth` again to store your login in the OS credential store. Existing project credentials still work.
