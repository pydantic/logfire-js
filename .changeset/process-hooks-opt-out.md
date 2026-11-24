---
'@pydantic/logfire-node': minor
---

Let applications own process shutdown. `configure()` installs listeners for `beforeExit`, `SIGTERM`, `uncaughtExceptionMonitor` and `unhandledRejection`. Its `SIGTERM` listener runs before a handler the application registers later and shuts the SDK down, so spans that handler recorded while it drained work, after waiting for timers or I/O, were lost, and its `unhandledRejection` listener kept Node from crashing. Set `advanced.processHooks: false` to install none of them; pass it on every `configure()` call. The application then calls `shutdown()` at the end of its own shutdown, and Node's default crash on an unhandled rejection applies. The default is unchanged.
