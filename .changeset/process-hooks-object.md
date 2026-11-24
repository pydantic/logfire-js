---
'@pydantic/logfire-node': minor
---

Let applications turn off single process listeners. `advanced.processHooks` now also takes an object with `beforeExit`, `sigterm`, `uncaughtException` and `unhandledRejection` keys, and a key that is left out stays on. For example, `{ sigterm: false }` lets the application's own `SIGTERM` handler drain work and export what it records, while Logfire keeps reporting uncaught exceptions and unhandled rejections. `true` and `false` keep their meaning.
