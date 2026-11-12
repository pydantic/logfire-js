---
'@pydantic/logfire-node': patch
---

Report uncaught exceptions and unhandled rejections whose value is not an `Error`, such as `throw 'boom'`, `Promise.reject(null)`, or an error whose `message` getter throws. They now get a span named `Uncaught error` or `Unhandled promise rejection`, the same names the browser package uses.
