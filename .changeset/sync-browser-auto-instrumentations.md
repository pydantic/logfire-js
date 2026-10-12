---
'@pydantic/logfire-browser': minor
---

Trace the clicks and requests that an application sets up during startup. The browser auto-instrumentations loaded through a dynamic import, so they patched `addEventListener`, `fetch`, and XHR only after `configure()` had returned. A listener registered before the patch, such as the delegated listeners that a framework root registers when it mounts right after configuration, never produced click spans, and requests sent before the patch were not traced. `configure()` and `configureFrontend()` now register the auto-instrumentations before they return, so applications that passed them through `instrumentations` only to register them early can return to `autoInstrumentations`. The auto-instrumentations are part of the main bundle, which adds about 8 kB gzipped for applications that bundle the browser SDK.
