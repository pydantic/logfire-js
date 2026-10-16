# Browser Capture Profiles

Apply one profile to the existing browser configuration from
[setup](./setup.md). These are alternatives, not successive calls to
`configureFrontend()`. Keep its generated `frontendOptions`, error capture,
identity, and privacy controls. Verify options against the installed SDK; do not
silently upgrade beyond the application's dependency constraints.

## Full frontend observability

`configureFrontend()` enables automatic browser instrumentation and Web Vitals
metrics by default. Add the optional replay integration when requested. Use this
for page loads, performance, request/interaction traces, and error investigation.
Replay is separate from those signals and needs its own sampling decision.

## Errors and replays with automatic instrumentation

Keep automatic instrumentation and tail-sample qualifying traces. Disable Web
Vitals when they are outside the requested signals; trace sampling does not
filter metric exports. Import OpenTelemetry's error status from a direct
dependency when using this callback:

```bash
npm install @opentelemetry/api
```

```ts
import { SpanStatusCode } from '@opentelemetry/api'
import * as logfire from '@pydantic/logfire-browser'
import { sessionReplayIntegration } from '@pydantic/logfire-session-replay/integration'

const frontend = logfire.configureFrontend({
  ...frontendOptions,
  autoInstrumentations: true,
  rum: { webVitals: false, longAnimationFrames: false },
  minLevel: 'error',
  sampling: {
    tail: ({ level, span }) => (level.gte('error') || span.status.code === SpanStatusCode.ERROR ? 1 : 0),
  },
  sessionReplay: sessionReplayIntegration({
    maskAllText: true,
    maskAllInputs: true,
    captureConsole: false,
    blockSelector: '[data-logfire-block]',
  }),
})
```

This accepts Logfire error/fatal events and spans marked with OpenTelemetry
error status. Do not assume that an HTTP response code alone sets that status
in every instrumentation/version; test 4xx, 5xx, and rejected network requests
that matter to the application. Report an important handled failure explicitly
when its instrumentation does not classify it as an error.

Tail sampling retains the entire qualifying **trace**, including its successful
spans. It does not retain every trace from the same browser session or recover
unrelated requests that finished before a later error. Global error reports may
start a separate trace; replay supplies their shared session context.

This SDK sampler decides browser exports. A backend receiving propagated trace
context makes its own decision and may retain spans whose browser parent was
dropped; do not promise a complete distributed trace from browser sampling alone.

Leave head sampling at its default of 1 when every qualifying error trace must
be eligible. A lower head rate can discard an error trace before its outcome is
known. `minLevel: 'error'` suppresses lower-severity manual logs, not unlevelled
spans or auto-instrumentation. It is supplementary to the tail callback.

Instrumentation still runs and tail sampling buffers undecided traces in browser
memory. Check a long-running/high-volume application before recommending this
profile for lower client overhead. Existing metrics/custom instrumentations may
emit additional signals; review them rather than promising that these options
silence every provider in the application.

## Minimal errors and replays

For lower instrumentation overhead, disable automatic spans and RUM performance
signals while keeping replay and explicit error reporting:

```ts
const frontend = logfire.configureFrontend({
  ...frontendOptions,
  autoInstrumentations: false,
  rum: { webVitals: false, longAnimationFrames: false },
  minLevel: 'error',
  sessionReplay: sessionReplayIntegration({
    maskAllText: true,
    maskAllInputs: true,
    captureConsole: false,
    blockSelector: '[data-logfire-block]',
  }),
})
```

Keep the SDK's default global error capture and framework boundary reporting from
[setup](./setup.md). Remove unwanted explicitly registered instrumentations and
manual unlevelled spans if strict signal limits are required. Normal Frontend
page-load, performance, and request charts will have little or no data from this
configuration. The replay may still contain network/navigation events; those
are recorder data, not automatic OTLP request spans.

Browser-session inactivity currently follows span activity, not replay events.
With few error spans, an actively used page can therefore rotate its session ID
after the idle timeout. Verify long recordings rather than assuming one replay
ID lasts for the whole page or login session.

## Choose replay sampling separately

Preserve the existing replay policy unless changing it is part of the request.
`sessionSampleRate` controls continuous recording. `onErrorSampleRate` keeps an
in-memory buffer for other eligible sessions and promotes it on uncaught
`window.error` or `unhandledrejection` events. Caught errors, `reportError()`, and
`console.error` do not automatically promote that buffer. Do not recommend
error-triggered recording alone when the application's errors are handled by
framework boundaries or catch blocks.

For a deterministic **local verification** recording, use `sessionSampleRate: 1`
and `onErrorSampleRate: 0`. That is a test override, not a production rate to
apply silently. Replay uploads are independent of the trace sampler. Recordings
shorter than `minSessionDurationMs` are not uploaded; the current default is 10
seconds. Preserve that default outside tests unless shorter recordings are
required.

Sources: [SDK trace sampling](https://pydantic.dev/docs/logfire/instrument/typescript/sampling/),
[recorder sampling](https://www.npmjs.com/package/@pydantic/logfire-session-replay),
and [browser replay configuration](https://pydantic.dev/docs/logfire/instrument/typescript/packages/browser/).
