/**
 * Logfire Agent Control, without an agent framework.
 *
 * An agent's Agent Control config is one Logfire variable holding an `AgentConfig`. This package
 * owns that contract -- the types, the stored JSON schema, and the variable plumbing -- plus the
 * pure helpers that apply a published value to whatever an agent framework happens to call its
 * instructions, its tools, and its settings.
 *
 * The split is the point. `AgentControl` is the only thing that talks to Logfire; `applyInstructions`,
 * `applyToolDefinitions`, `applySettings`, and `buildBaseline` are pure functions over plain data.
 * An adapter for a new framework is: enumerate a baseline, install the framework's hook, call two
 * pure helpers. See the README for a worked one.
 */

export { buildBaseline } from './baseline'
export type { BaselineInput } from './baseline'

export type { AgentConfig, AgentConfigSettings, InstructionBlockConfig, ParameterOverride, ToolDefinitionOverride } from './config'
export { canonicalSettings, CANONICAL_SETTINGS_KEYS, parseAgentConfig } from './config'

export { AgentControl, currentResolution, useResolution } from './control'
export type { AgentControlOptions, BaselineSource, PublishBaselineOptions, Resolution } from './control'

export { applyInstructions, instructionEntries } from './instructions'
export type { AppliedInstructions, ApplyInstructionsOptions, InstructionBlock } from './instructions'

export { mergeSettings } from './merge'
export type { Provenance, SettingsLayer, SettingSource } from './merge'

export { AGENT_VARIABLE_PREFIX, agentVariableName, normalizeAgentName } from './names'

export { AGENT_CONFIG_JSON_SCHEMA, canonicalJson, MAX_MODEL_FACING_TEXT_LENGTH, SCHEMA_SHA256 } from './schema'
export type { JsonSchema } from './schema'

export { applySettings, reportUnapplied } from './settings'
export type { ApplySettingsOptions } from './settings'

export { applyToolDefinitions, toolKey, withParameterDescriptions } from './tools'
export type { AppliedTools, ApplyToolDefinitionsOptions, CollisionScope, ToolDef, ToolKey } from './tools'

export { isRepresentableTimeout, MAX_TIMEOUT_MILLISECONDS, MAX_TIMEOUT_SECONDS, toMilliseconds } from './units'

export { UnmatchedConfigError, warnOnce } from './warnings'
export type { OnUnmatched, UnappliedEntry, UnappliedReason } from './warnings'
