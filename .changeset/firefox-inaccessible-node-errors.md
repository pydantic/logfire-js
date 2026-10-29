---
'@pydantic/logfire-session-replay': patch
'@pydantic/logfire-browser': patch
---

Keep errors from page nodes that the page script cannot access out of the application's global error handler.

In Firefox, a node that the page script cannot access, such as one a browser extension inserted, throws `Permission denied to access property "..."` when it is read. Session replay could throw `Permission denied to access property "nodeType"` from rrweb's mutation handling on every DOM change, and the click instrumentation could throw `Permission denied to access property "localName"` when it built the target's XPath. Both reached `window.onerror`.

- Session replay now registers an rrweb error handler. rrweb drops errors from its observer callbacks and keeps recording, and the `onError` option receives each distinct message once.
- The browser SDK skips the span for an interaction whose target the instrumentation cannot read, and logs one diagnostic warning.
