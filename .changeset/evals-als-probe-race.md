---
'logfire': patch
---

Give every concurrent eval case its own task-run context on the first `Dataset.evaluate` of a process. The `AsyncLocalStorage` probe marked itself done before awaiting its dynamic import, so cases starting while the import was in flight fell through to the shared single-slot fallback and their `setEvalAttribute` / `incrementEvalMetric` calls were silently dropped. The probe is now cached as a promise every caller awaits.
