/**
 * Applying the `settings` section, and saying which sections and keys this adapter could not apply.
 *
 * There are three ways a published setting fails to reach the model, and they used to be found in
 * three different places. A key *this SDK* has no field for is found when the value is parsed. A key
 * this SDK understands but the *adapter's framework* has no knob for is known only to the adapter,
 * which had to filter the patch itself and then remember to call a separate reporter -- and a
 * forgotten call was a silent drop, the exact failure this contract exists to prevent. A `timeout`
 * that is not a request budget is found here. All three are the same gap between what Logfire shows
 * and what the agent does, so all three now come back on one result, for one reporter to apply one
 * policy to.
 */

import { CANONICAL_SETTINGS_KEYS, UNRECOGNIZED_SECTIONS, UNRECOGNIZED_SETTINGS } from './config'
import type { AgentConfig, AgentConfigSettings } from './config'
import type { AgentSupport, Section } from './support'
import { isRepresentableTimeout, MAX_TIMEOUT_SECONDS } from './units'
import { repr } from './warnings'
import type { ApplyIssue } from './warnings'

/** Options for `applySettings`. */
export interface ApplySettingsOptions {
  /**
   * What this adapter can apply; see `AgentSupport`.
   *
   * Absent says it can apply every section and every canonical setting, which is the right answer
   * for an adapter that has not been taught to declare yet and the wrong one for any that has.
   */
  support?: AgentSupport | null | undefined
}

/** What `applySettings` returns: the patch to merge, and what reached nothing. */
export interface AppliedSettings {
  /** The canonical settings patch: every key that was published and can be applied. */
  settings: AgentConfigSettings
  /**
   * Every published key, and every whole section, this request did not apply; see `ApplyIssue`.
   *
   * Reported by nothing here; hand them to `AgentControl.report` with the rest. The shape is the same
   * as the other two sections' so an adapter treats all three alike, which is what it could not do
   * while this one returned a bare patch and a reporter of its own.
   */
  issues: readonly ApplyIssue[]
}

/**
 * What this release, and this adapter, cannot do with the sections a value carries.
 *
 * Two decisions about the config as a whole rather than about any one entry: a top-level key this
 * release has no section for, and a section it does have and the adapter declared it cannot apply.
 *
 * The first is the other half of the openness that makes a future `mcp_servers` or `skills` section
 * readable by an older SDK. Unknown keys are ignored on purpose -- refusing them would make the day a
 * section is added the day every older SDK stops resolving -- but an ignored key that nobody hears
 * about is how the first person to publish one gets a silently degraded agent.
 */
function sectionIssues(config: AgentConfig, support: AgentSupport | null | undefined): ApplyIssue[] {
  const issues: ApplyIssue[] = (config[UNRECOGNIZED_SECTIONS] ?? []).map((name) => ({
    section: name,
    reason: 'unknown-section' as const,
    message:
      `Managed agent config publishes a ${repr(name)} section, which this version of the SDK has no ` +
      'section for; that section is not applied.',
  }))
  if (support === undefined || support === null) {
    return issues
  }
  const published: [Section, unknown][] = [
    ['instructions', config.instructions],
    ['model', config.model],
    ['settings', config.settings],
    ['tool_definitions', config.tool_definitions],
  ]
  for (const [name, value] of published) {
    if (value !== undefined && !support.sections.includes(name)) {
      issues.push({
        section: name,
        reason: 'unsupported-section',
        message:
          `Managed agent config publishes a ${repr(name)} section, which this agent framework has no ` +
          'way to apply; that section is not applied.',
      })
    }
  }
  return issues
}

/**
 * The canonical settings a managed config sets, as a patch to merge over the code-defined ones.
 *
 * Only keys the value actually set are present, so `settings` is a patch and not a set of defaults:
 * an adapter merges it over whatever its framework is already running with, and every key it does not
 * contain keeps its code-defined value.
 *
 * Five kinds of published thing come back on `issues` rather than being silently dropped:
 *
 * - a key this release has no field for (`'unknown-setting'`), which a newer Logfire UI can write;
 * - a key this adapter cannot lower into its framework (`'unsupported-setting'`), which it names
 *   through `AgentSupport.settings`;
 * - a `timeout` that is not a representable request budget (`'unrepresentable-timeout'`) -- negative,
 *   not finite, or past `MAX_TIMEOUT_SECONDS`. Dropped rather than clamped, because clamping turns
 *   "no real limit" into a deadline nobody published, and rounding a negative one to `0` cancels the
 *   request before it is sent;
 * - a top-level key this release has no section for (`'unknown-section'`);
 * - a section this adapter declared it cannot apply (`'unsupported-section'`).
 *
 * An adapter that declares it cannot apply the `settings` section at all gets an empty patch and the
 * one `'unsupported-section'` issue, whatever its `AgentSupport.settings` says.
 *
 * The last two are about the whole config rather than about settings, and they are here because this
 * is the helper every adapter can call with the whole config and its own support declaration,
 * whatever hooks its framework gives it: an adapter that never calls `applyInstructions` would
 * otherwise have nowhere to learn that an `instructions` section was published at an agent that
 * cannot apply one.
 *
 * Nothing is reported here, and nothing throws: parsing and applying both run where a throw would be
 * swallowed into a fallback to code, so the policy is applied once, later, by `AgentControl.report`.
 */
export function applySettings(config: AgentConfig, options: ApplySettingsOptions = {}): AppliedSettings {
  const { support } = options
  const issues = sectionIssues(config, support)
  const settings = config.settings
  if (settings === undefined || (support !== undefined && support !== null && !support.sections.includes('settings'))) {
    // An adapter that declared it cannot apply the section has already been told so, once, by
    // `sectionIssues`. Handing it the patch anyway would be this function contradicting that
    // declaration, and reporting every key in it a second time would bury the one report that
    // matters under a list of keys the adapter was never going to reach.
    return { settings: {}, issues }
  }
  for (const name of settings[UNRECOGNIZED_SETTINGS] ?? []) {
    issues.push({
      section: 'settings',
      reason: 'unknown-setting',
      setting: name,
      message: `Managed agent config sets ${repr(name)}, which this version of the SDK has no model setting for; that key is not applied.`,
    })
  }
  const applied: AgentConfigSettings = {}
  for (const key of CANONICAL_SETTINGS_KEYS) {
    const value = settings[key]
    if (value === undefined) {
      continue
    }
    if (key === 'timeout' && typeof value === 'number' && !isRepresentableTimeout(value)) {
      issues.push({
        section: 'settings',
        reason: 'unrepresentable-timeout',
        setting: key,
        message:
          `Managed agent config sets a request timeout of ${repr(value)} seconds, which is not a budget a ` +
          `request can be given -- it has to be finite, not negative, and no larger than ${String(MAX_TIMEOUT_SECONDS)} ` +
          `seconds; that key is not applied.`,
      })
      continue
    }
    if (support !== undefined && support !== null && !(support.settings ?? []).includes(key)) {
      issues.push({
        section: 'settings',
        reason: 'unsupported-setting',
        setting: key,
        message: `Managed agent config sets ${repr(key)}, which this agent framework has no model setting for; that key is not applied.`,
      })
      continue
    }
    ;(applied as Record<string, unknown>)[key] = value
  }
  return { settings: applied, issues }
}
