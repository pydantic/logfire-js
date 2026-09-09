/**
 * Applying the `settings` section, and reporting the keys an adapter could not lower.
 *
 * There are two ways a published setting fails to reach the model, and they are found in different
 * places. A key *this SDK* has no field for is found when the value is parsed, and is reported by
 * `applySettings`. A key this SDK understands but the *adapter's framework* has no knob for is only
 * known to the adapter, which reports it with `reportUnapplied`. Both are the same gap between what
 * Logfire shows and what the agent does, so both go through the same `onUnmatched` policy.
 */

import { CANONICAL_SETTINGS_KEYS, UNRECOGNIZED_SETTINGS } from './config'
import type { AgentConfig, AgentConfigSettings } from './config'
import { isRepresentableTimeout, MAX_TIMEOUT_SECONDS } from './units'
import { reportUnmatched, repr } from './warnings'
import type { OnUnmatched } from './warnings'

/** Options for `applySettings` and `reportUnapplied`. */
export interface ApplySettingsOptions {
  /** What to do with a published settings key that is not applied. */
  onUnmatched?: OnUnmatched
}

/**
 * The canonical settings a managed config sets, as a patch to merge over the code-defined ones.
 *
 * Only keys the value actually set are present, so the result is a patch and not a set of defaults:
 * an adapter merges it over whatever its framework is already running with, and every key it does
 * not contain keeps its code-defined value.
 *
 * Also reports, under `onUnmatched`, every `settings` key the published value carried that this
 * release has no field for -- reported here, at the point the patch is applied, rather than at parse
 * time, because parsing runs inside the SDK's variable resolution where a throw would be swallowed
 * into a fallback to code instead of failing the run.
 *
 * A published `timeout` that is not a representable request budget -- negative, not finite, or past
 * `MAX_TIMEOUT_SECONDS` -- is dropped and reported here too. Dropped rather than clamped, because
 * clamping turns "no real limit" into a deadline nobody published, and rounding a negative one to
 * `0` cancels the request before it is sent.
 *
 * Returns an empty object when no `settings` section is published, which merges to a no-op.
 */
export function applySettings(config: AgentConfig, options: ApplySettingsOptions = {}): AgentConfigSettings {
  const onUnmatched = options.onUnmatched ?? 'warn'
  const settings = config.settings
  if (settings === undefined) {
    return {}
  }
  for (const name of settings[UNRECOGNIZED_SETTINGS] ?? []) {
    reportUnmatched(
      onUnmatched,
      `Managed agent config sets ${repr(name)}, which this version of the SDK has no model setting for; that key is not applied.`
    )
  }
  const applied: AgentConfigSettings = {}
  for (const key of CANONICAL_SETTINGS_KEYS) {
    const value = settings[key]
    if (value === undefined) {
      continue
    }
    if (key === 'timeout' && typeof value === 'number' && !isRepresentableTimeout(value)) {
      reportUnmatched(
        onUnmatched,
        `Managed agent config sets a request timeout of ${repr(value)} seconds, which is not a budget a ` +
          `request can be given -- it has to be finite, not negative, and no larger than ${String(MAX_TIMEOUT_SECONDS)} ` +
          `seconds; that key is not applied.`
      )
      continue
    }
    ;(applied as Record<string, unknown>)[key] = value
  }
  return applied
}

/**
 * Report settings keys the adapter's framework has no knob for.
 *
 * `applySettings` hands back the canonical patch without knowing what the framework on the other
 * side can do with it. An adapter that cannot lower `top_k`, or whose framework has no `seed`, calls
 * this with those key names so the same `onUnmatched` policy governs them -- otherwise a published
 * setting would be silently dropped at the last step, which is the one thing this contract is meant
 * not to do.
 *
 * Reporting nothing is a no-op, so an adapter can call it unconditionally with whatever it skipped.
 */
export function reportUnapplied(keys: Iterable<string>, options: ApplySettingsOptions = {}): void {
  const onUnmatched = options.onUnmatched ?? 'warn'
  for (const name of keys) {
    reportUnmatched(
      onUnmatched,
      `Managed agent config sets ${repr(name)}, which this agent framework has no model setting for; that key is not applied.`
    )
  }
}
