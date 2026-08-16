---
'logfire': patch
---

Stop `instrument` with `recordReturn` rethrowing when the returned value has a throwing `then` getter. Detecting a thenable reads `then`, which runs caller code, so a successful call could surface to the caller as a thrown error and be recorded on the span as a failure. The probe now treats a throwing getter as not thenable.
