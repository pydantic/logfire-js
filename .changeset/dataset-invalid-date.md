---
'logfire': patch
---

Report an invalid `Date` in a pushed evaluation dataset as a `DatasetConfigurationError` instead of a bare `RangeError`. `normalizeHostedJsonValue` called `toISOString()` on any `Date`, which throws `RangeError: Invalid time value` for an unparseable one, losing the field, case and path that every other unsupported value reports and bypassing the `serializeValue` hook that can convert it.
