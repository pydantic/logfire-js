# Spike 02: How can multi-chunk replay unload delivery start safely?

## Status

CONCLUSIVE

## Question

Can all replay chunks needed during `pagehide` or hidden-page shutdown be started before the page freezes without exceeding browser keepalive limits or changing the authenticated replay ingest contract?

## Why It Blocks Planning

The current serial loop starts later chunks only after earlier responses finish. Replacing it with unconstrained concurrency could instead exceed the browser's shared keepalive quota. The result determines the delivery algorithm and its outside-in browser validation.

## Hypotheses and Decision Rule

- If independent keepalive fetches may all start safely, launch chunks concurrently.
- If keepalive is governed by an aggregate in-flight body quota, launch only a compressed set that fits a conservative aggregate budget and make excess delivery explicitly best effort.
- If `sendBeacon()` preserves the existing headers and encoding, use it for unload delivery; otherwise retain fetch.

## Minimal Experiment

- Environment and exact versions: commit `f57d9ec`; Node.js `24.14.1`; replay package with `fflate` `0.8.3`.
- Setup: force three keepalive chunks; mock delivery promises so the first response remains pending; count request starts and maximum active requests. Compare bounded concurrency with the Fetch and Beacon specifications.
- Action: call keepalive flush before resolving any delivery promise, then release responses one at a time.
- Observation to capture: how many requests start synchronously, active body bytes, and whether Beacon can carry the required authorization/custom headers and `Content-Encoding`.
- Safety and side-effect constraints: isolated `/tmp` scratch only; no source or dependency changes; no real endpoint or credentials.

## Evidence

- The read-only three-chunk probe observed one request start before the first response resolved, then the second and third sequentially; maximum active requests was one.
- `packages/logfire-session-replay/src/transport.ts:78-105` awaits each `deliver()` inside the chunk loop.
- `packages/logfire-session-replay/src/transport.ts:153-165` compresses each body and sends with keepalive when the body is at most 60,000 bytes.
- `packages/logfire-session-replay/src/transport.ts:286-306` splits on estimated uncompressed event bytes, not aggregate compressed in-flight bytes.
- The [WHATWG Fetch Standard](https://fetch.spec.whatwg.org/#http-network-or-cache-fetch) sums unfinished keepalive request body lengths in the client's fetch group and returns a network error above 64 KiB.
- The [W3C Beacon specification](https://www.w3.org/TR/beacon/#sendbeacon-method) shares the same keepalive quota and constructs its own limited header list. Its API accepts only URL and body, so it cannot preserve arbitrary authorization/custom headers required by the current replay transport.

## Result

- Outcome: CONCLUSIVE.
- Observed behavior: current serial response waiting prevents later chunks from starting before freeze. Unconstrained concurrency is also invalid because unfinished keepalive bodies share a 64 KiB budget. `sendBeacon()` is not a drop-in replacement for the authenticated gzip transport.
- Decision: pre-compress/package unload chunks, then start fetch requests only while their aggregate compressed bodies remain within a conservative budget below the browser limit. Do not wait for one response before starting the next permitted request. Treat excess buffered replay as best effort and rely on periodic flushing to keep unload payloads small.
- Rejected alternatives: response-serial starts; unbounded `Promise.all`; a chunk-count-only limit; `sendBeacon()` without an explicit transport contract change.
- Representativeness limits: the scratch probe modeled scheduling but did not run page lifecycle freezing in a real browser. Browser competition from unrelated keepalive requests means no library-local budget can guarantee delivery.

## Planning Impact

- Roadmap or PRP sections/tasks/tests changed by this result: unload reliability belongs in the core replay reliability child, with aggregate byte budgeting and direct real-browser `pagehide` evidence.
- Consumer Contract, `CX-N` scenarios, or required evidence grade changed by this result: DIRECT browser evidence is required from public replay startup through a local proxy that records and gunzips sequence-numbered requests while the first response is delayed.
- Remaining uncertainty: select the conservative library budget and exact excess-buffer/error reporting policy during child research; validate behavior in the repository's available browser runner.

## Cleanup

- Disposable artifacts removed: `/tmp/prp-023-replay-delivery`.
- Repository and external state checked: no source, dependency, credential, or external state changes.
