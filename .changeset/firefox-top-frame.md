---
'logfire': patch
---

Keep the top stack frame when fingerprinting an error in Firefox or Safari. Frame parsing dropped the first line of `error.stack` to skip V8's `Error: message` header, but those engines have no header line, so the frame that identifies the error was discarded and two unrelated errors sharing the frame below it received the same `logfire.exception.fingerprint`.
