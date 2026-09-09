---
'logfire': patch
---

Carry a task's own return value through the evals output seams. `renderReport` crashed the whole report when a case's output or inputs held a BigInt (which `JSON.stringify` throws on) or was `undefined` (which it refuses to stringify); `recordReturn` lost the entire return value to one BigInt field. Both now serialize under the same replacer the attribute seam applies, so a BigInt survives as an exact number or decimal string and a `void` task renders as `undefined` in its cell.
