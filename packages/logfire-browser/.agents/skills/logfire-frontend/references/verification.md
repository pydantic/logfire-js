# Verify Browser Telemetry and Replay

Verify in the user's selected application and exact Logfire project. Use the
available browser tool; do not treat a Node-only SDK script as browser proof.
Keep a test time window, application name, and non-sensitive test operation so
old telemetry cannot satisfy the check.

## Exercise the selected capture profile

Run the normal typecheck/build, start the browser app using its documented dev
command, and exercise:

1. A successful request and ordinary navigation/interaction.
2. The relevant HTTP failure (4xx/5xx or rejected fetch), an uncaught JavaScript
   error, and an unhandled rejection. Use controlled non-sensitive test failures.
3. A failure caught by the application or framework boundary, reported through
   `reportError()` if that is part of the user's desired coverage.

Inspect browser requests to the configured trace, metric, and replay endpoints.
For the error-tail profile, successful standalone traces should be omitted;
qualifying error traces should survive. Successful spans within an accepted
error trace are expected. No Web Vitals metric exports should occur when that
capture is disabled. For the minimal profile, automatic request spans should be
absent while explicitly reported errors remain.

Do not infer which failed HTTP responses qualify from the configuration alone:
inspect exported status/level with the installed instrumentation. The sampler's
decision does not prove that JavaScript errors were reported; exercise the
listeners and caught-error path separately. Ensure reinitialization and React
Strict Mode do not create duplicate providers or duplicate error reports.

## Confirm fresh telemetry in Logfire

Use existing read-capable native MCP or the Logfire UI for the exact project.
Do not require a CLI login or SDK write token for browser setup. If CLI account
access is specifically needed, use the
[CLI connection guide](../../logfire-coding-agents/references/connection.md).
Restricted frontend tokens and ordinary SDK write tokens cannot query data.

Use a bounded query for the exercised frontend application and time window:

```sql
SELECT start_timestamp, trace_id, service_name, message,
       attributes->>'session.id' AS session_id
FROM records
WHERE service_name = 'customer-portal'
  AND start_timestamp > now() - interval '15 minutes'
ORDER BY start_timestamp DESC
LIMIT 20
```

Replace the synthetic service name and time window with confirmed values.
Require fresh rows for the exercised errors with the frontend application's
identity and a non-empty `session.id`. Inspect the error/exception details and
any associated request spans. Full RUM also needs fresh page-load/request data
and browser-supported Web Vitals; do not require performance charts from an
errors-only profile. If reads are unavailable, mark ingestion unverified.

## Verify a playable recording

When replay is requested, keep the tab active and interact for longer than the
configured minimum recording duration. For a deterministic local test only,
set continuous recording to 1; do not change deployed sampling merely to make
one test pass. Check the replay controller actually started and uploads reached
the configured destination.

Open **Frontend → Session Replays** with a time range including the session's
start. Open the matching recording and verify that playback, navigation/click
markers, and the activity list advance together. Confirm the error's `session.id`
matches the recording and its timestamp falls within the recorded time bounds.
Use the recording's browser-telemetry link to verify the relevant error appears.

For the privacy check, use synthetic visible text/input values and a synthetic
blocked region. Confirm masking and omission in the recording; test the actual
application's sensitive attributes/URLs separately. An upload response proves
transport acceptance, not successful playback or masking.

If a playback-capable browser or read access is unavailable, report the browser
and transport checks performed and explicitly leave ingestion/playback
unverified. Return the clean project or recording link verified in the UI or
returned by the available MCP tool. Do not invent a private replay URL/API or
inject credentials into a browser. Link creation is a separate convenience,
never an ingestion check.

## Troubleshooting

- **No browser errors:** check whether the exception was caught, whether its
  reporting handler ran, and whether head/tail sampling discarded its trace.
- **No replay:** check Early Access availability, actual recorder mode/sample
  choice, minimum duration, failed imports, content blockers, CSP, and upload
  authentication. A sampled-off controller is not a transport failure.
- **Replay exists but no matching spans:** check the exact app/project, shared
  `session.id`, recording time bounds, retention, and trace sampling. Error-only
  sampling intentionally omits healthy standalone traces.
- **Recording gaps:** inspect failed/retried chunk uploads and downloads. A
  page-close flush is best effort; in-memory chunks do not survive reloads.
- **Duplicate setup or capture:** initialize one module/provider, install error
  listeners once, and exclude telemetry/replay uploads from both instrumentation
  and recorder network capture. Preserve built-in endpoint exclusions when
  adding custom ignore patterns or a proxy.

Source: [Session Replays verification](https://pydantic.dev/docs/logfire/observe/session-replays/).
