---
'logfire': patch
---

Treat a variable named like an `Object.prototype` member as unconfigured. `getVariableConfig` read the variables record with a plain index, so `defineVar('constructor')` or `defineVar('valueOf')` found the inherited member, handed it back as if it were a variable config, and failed downstream: the value still fell back to the code default but the resolution reason was reported as `other_error` rather than `code_default`.
