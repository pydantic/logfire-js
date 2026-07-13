# Spike 03: Can replay preserve a batch when CSP blocks fflate workers?

## Status

CONCLUSIVE

## Question

When Content Security Policy or browser capability prevents `fflate` from creating its Blob worker, can the same replay batch be compressed synchronously and delivered without loss?

## Why It Blocks Planning

Periodic replay delivery currently uses asynchronous `fflate` compression. A synchronous worker-construction failure rejects the batch before fetch. The fallback must be proven to retain the original bytes and must not double-report errors or retry an already-consumed buffer.

## Hypotheses and Decision Rule

- If asynchronous compression failure leaves the original input bytes intact, catch both setup and callback failures and retry that same input with `gzipSync`.
- If the worker path consumes or detaches input, do not fallback without retaining a separate copy.
- If synchronous compression also fails, report once and send nothing.

## Minimal Experiment

- Environment and exact versions: commit `f57d9ec`; Node.js `24.14.1`; `fflate` `0.8.3` browser build.
- Setup: exercise `fflate.gzip` with `Worker` absent, Blob/URL/worker construction throwing, and worker callback failure; retain the input bytes and attempt `gzipSync` after each failure.
- Action: compress a deterministic replay envelope, gunzip fallback output, and compare it with the original bytes. Separately make fallback fail and count error/fetch calls.
- Observation to capture: synchronous throw versus rejected promise/callback error, input detachment, fallback validity, error count, and network calls.
- Safety and side-effect constraints: isolated `/tmp` scratch only; no source or dependency changes; no browser or external endpoint required.

## Evidence

- Installed `fflate` browser source creates a Blob URL and `Worker` for asynchronous gzip. Worker capability/construction failures occur before its callback; runtime worker failures arrive through the callback.
- The current promise wrapper at `packages/logfire-session-replay/src/transport.ts:309-318` turns setup throws into rejection, and `deliver()` at `:161-168` reports the error without a fallback, so the batch is not fetched.
- Scratch probes confirmed that keeping `consume: false` retains the input for a valid `gzipSync` fallback. With consuming transfer enabled, detachment can make fallback impossible.
- The fallback gzip output decompressed to the original replay envelope. A forced fallback failure could be contained with one error report and zero fetch calls.

## Result

- Outcome: CONCLUSIVE.
- Observed behavior: both worker setup and callback failures can be caught around the asynchronous compressor, and the same retained bytes can be synchronously compressed and delivered. Input-consuming transfer must not be enabled.
- Decision: add a compression helper that catches asynchronous setup/callback failure, memoizes worker-path unavailability for later batches, and uses `gzipSync` on the retained input. A successful fallback is normal degradation and must not call `onError`; failure of both paths reports once and performs no fetch.
- Rejected alternatives: dropping the batch; enabling consuming transfer; reporting a recovered worker failure as an application error; retrying the worker on every later batch after deterministic capability failure.
- Representativeness limits: scratch probes exercised the installed browser implementation but not a real browser enforcing a CSP header. A real-browser `worker-src 'none'` smoke test remains required.

## Planning Impact

- Roadmap or PRP sections/tasks/tests changed by this result: CSP-safe compression belongs in the core replay reliability child; unit tests must cover setup throw, callback error, valid fallback bytes, memoization, and double-failure containment.
- Consumer Contract, `CX-N` scenarios, or required evidence grade changed by this result: DIRECT browser evidence is required under an actual restrictive CSP, using ordinary public replay flush and a local proxy that receives valid gzip.
- Remaining uncertainty: whether the real-browser runner can set the needed CSP without a new fixture; this is child-level validation setup, not an architectural uncertainty.

## Cleanup

- Disposable artifacts removed: `/tmp/prp-023-replay-delivery`.
- Repository and external state checked: no source, dependency, credential, or external state changes.
