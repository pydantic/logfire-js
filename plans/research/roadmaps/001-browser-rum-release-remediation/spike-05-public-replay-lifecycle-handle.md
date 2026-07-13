# Spike 05: Can browser configure expose replay lifecycle without breaking cleanup consumers?

## Status

CONCLUSIVE

## Question

Can `@pydantic/logfire-browser` expose replay `flush()`, `stop()`, and current
mode from the value returned by `configure()` while preserving the existing
callable cleanup contract and safely handling asynchronous replay startup?

## Why It Blocks Planning

R6 must settle D3 before the first stable browser release. Returning a new
object shape could break every consumer that calls the current cleanup
function, while a process-global replay getter could become ambiguous across
the provider generations and reconfiguration lifecycle established by R2.

## Hypotheses and Decision Rule

- If a callable interface with an optional replay property remains assignable
  to `() => Promise<void>` and a facade can safely queue lifecycle operations
  across lazy startup, choose an augmented callable configure handle.
- If TypeScript compatibility or startup/cleanup coordination fails, do not
  expose the handle through `configure()`; evaluate a separate API.
- If neither shape can be exercised conclusively, leave D3 unresolved.

## Minimal Experiment

- **Environment and exact versions**: repository Node 24 toolchain and installed
  TypeScript; current browser configure/replay implementation at `aae49f6`.
- **Setup**: two disposable files under
  `/private/tmp/logfire-js-d3-spike`: a TypeScript public-shape consumer and a
  Node runtime model of lazy replay startup.
- **Action**: compile existing cleanup assignment/call syntax plus replay-handle
  property usage; run early `flush()`, early/repeated `stop()`, repeated cleanup,
  successful delayed startup, and contained missing-runtime cases.
- **Observation to capture**: type compatibility, promise identity, call order,
  conservative pre-start/post-stop state, and no failure for absent replay.
- **Safety and side-effect constraints**: no production source, dependencies,
  browser globals, credentials, or external state changed.

## Evidence

- **Repository observations**:
  - `packages/logfire-browser/src/index.ts` returns a callable cleanup with a
    stable repeated-call promise and already owns the replay startup promise.
  - cleanup waits for startup and stops replay before instrumentation, metrics,
    and trace shutdown.
  - `BrowserSessionReplayRuntime` already provides `mode`, `recording`,
    `flush()`, and idempotent `stop()` behavior behind callback containment.
  - existing examples, docs, fixtures, and tests call the configure result as a
    function, so replacing it with a plain object is incompatible.
  - R2's provider-generation lifecycle makes a global “current replay” getter
    less precise than a generation-scoped configure result.
- **Commands run**:

  ```bash
  node_modules/.bin/tsc --noEmit --target ES2022 --module NodeNext \
    --moduleResolution NodeNext --strict --skipLibCheck \
    /private/tmp/logfire-js-d3-spike/type-shape.mts
  node /private/tmp/logfire-js-d3-spike/runtime-shape.mjs
  ```

- **Relevant output summary**: TypeScript compiled without errors. The runtime
  model printed `callable compatibility and startup/cleanup races passed` after
  proving delayed-start flush/stop ordering, repeated stop identity, repeated
  cleanup identity, conservative `off` state, and absent-runtime no-ops.
- **Artifacts or source locations**: disposable experiment removed after this
  record; the tested shape and assertions are described above.

## Result

- **Outcome**: CONCLUSIVE.
- **Observed behavior**: an interface that is both callable and has an optional
  `sessionReplay` property is structurally compatible with the current cleanup
  function type. A generation-scoped facade can wait for lazy startup, preserve
  idempotence, and report `mode: 'off'` / `recording: false` before readiness,
  after startup failure, and after stop.
- **Decision**: D3 is settled for the stable release. Expose lifecycle through
  the callable configure result—not a replacement object or global getter:

  ```ts
  interface BrowserConfigureHandle {
    (): Promise<void>
    readonly sessionReplay?: BrowserSessionReplayHandle
  }

  interface BrowserSessionReplayHandle {
    readonly mode: 'full' | 'buffer' | 'off'
    readonly recording: boolean
    flush(): Promise<void>
    stop(): Promise<void>
  }
  ```

  `sessionReplay` exists synchronously only when replay was configured. Its
  methods wait for lazy startup; startup failure behaves as an absent/off
  runtime. `stop()` stops replay only and is idempotent; the callable handle is
  still required for complete SDK shutdown. `flush()` invoked after shutdown
  begins should join shutdown/no-op rather than touch a stopped recorder.
  Session identity remains available through the existing
  `getBrowserSessionId()` API and should not be duplicated on this handle.

- **Rejected alternatives**:
  - replacing the callable return with `{ shutdown, sessionReplay }`, because it
    breaks existing cleanup calls;
  - a global `getSessionReplay()` API, because it obscures generation ownership
    during reconfiguration;
  - a readiness callback, because it makes controlled-navigation flushing
    harder and exposes optional startup timing to consumers.
- **Representativeness limits**: the scratch runtime modeled the relevant
  promise/state transitions but did not modify or execute the production
  implementation in a browser. The R6 PRP must prove the facade through public
  package types, startup failure, early calls, reconfiguration, and a packed
  minimal consumer. The spike establishes feasibility, not whether consumers
  value the additional stable API surface.

## Planning Impact

- **Roadmap or PRP sections/tasks/tests changed by this result**: user sign-off
  on 2026-07-13 selected the generation-scoped callable facade above. R6 can be
  generated without another D3 architecture or product decision.
- **Consumer Contract, `CX-N` scenarios, or required evidence grade changed by
  this result**: `CX-8` should compile both legacy callable cleanup usage and
  documented replay-handle usage against packed output, then exercise early
  flush, replay-only stop, full cleanup, startup failure, and repeated calls.
- **Remaining uncertainty**: none for D3. D4 and metrics-degradation policy
  remain independent R6 decisions.

## Cleanup

- **Disposable artifacts removed**: `/private/tmp/logfire-js-d3-spike`.
- **Repository and external state checked**: only this evidence record and the
  parent roadmap decision/progress notes were changed; no external state was
  mutated.
