/**
 * The span an agent reports its code baseline on, which is how an agent gets a managed config.
 *
 * Nothing in this package writes a variable. An agent reports what it says in code, once per process,
 * on one `agent_control_config_hint` span; Logfire turns that into a config for an agent it has none
 * for, or offers to refresh a stored baseline the code has moved on from. Creating the config is a
 * person's click on the Logfire side, not an SDK's `POST` -- which is what keeps an agent's managed
 * config something someone decided to have rather than something a deployment made for them.
 *
 * The span name and every attribute name here are a cross-language contract, shared byte for byte
 * with the Python core and the Pydantic AI capability and indexed by the platform. They are not this
 * package's to rename.
 */

import { createHash } from 'node:crypto'

import { span } from 'logfire'
import { getVariableProvider } from 'logfire/vars'
import type { VariableProvider } from 'logfire/vars'

import { logfireConfig } from '../logfireConfig'
import type { AgentConfig, InstructionBlockConfig, ToolDefinitionOverride } from './config'
import { canonicalJson, SCHEMA_SHA256 } from './schema'

/**
 * The span an agent reports itself on, and the name a Logfire-side query selects it by.
 *
 * Static and separate from the message, so the message can be reworded without moving what the
 * platform indexes on. The attributes it carries are documented on `reportConfigHint`.
 */
const CONFIG_HINT_SPAN_NAME = 'agent_control_config_hint'

/**
 * The hint span's message.
 *
 * The agent it is about is the trace it sits in, and the variable it names is an attribute, so the
 * message stays the same string for every agent.
 */
const CONFIG_HINT_MESSAGE = 'Agent Control reported the code baseline for this agent'

/**
 * Where a reported baseline came from, which an adapter has to say because it changes what it means.
 *
 * - `'code'` is the agent *as written*: read off the agent object, its declared prompts, its declared
 *   settings, its tool definitions. It describes every request the agent will make.
 * - `'observed'` is one request, snapshotted because the framework offers nothing to read the agent
 *   from until it runs. It describes the request it came from and nothing else, so a prompt or a tool
 *   list assembled from the run's own input is a sample rather than a description -- and text that
 *   came from a request is one tenant's, one user's, one retrieved document's, reported into the
 *   telemetry of a project every one of its members can read.
 *
 * The distinction is not cosmetic: an adapter that can only observe should mark blocks it did not find
 * in code as dynamic rather than reporting their rendered text, and the editor has to be able to tell
 * a description of the code from a description of one request that happened first. It is also what
 * chooses the default `BaselinePublication`.
 */
export type BaselineSource = 'code' | 'observed'

/**
 * How much of a baseline leaves this process on the hint span.
 *
 * - `'text'` reports the whole baseline: instruction text, tool descriptions, parameter descriptions.
 *   It is what makes the Logfire editor able to show the agent's own prompt as the thing a managed
 *   value is layered onto, and it is the right answer for a baseline read off the code.
 * - `'structure'` reports every seam and no text at all: instruction ids and their `dynamic` flags,
 *   tool names, toolsets, parameter names, the model, and the settings -- enough for the editor to
 *   offer an override for each of them, with none of the prose. This is the agent's baseline under
 *   that policy, not a redaction of a fuller one: the digest and the byte count describe what is
 *   reported, so two deployments running the same code under the same policy still agree.
 * - `'off'` reports no baseline at all. The span is still emitted -- the agent still registers, and
 *   `baseline_sha256` still says whether two reports describe the same code -- but
 *   `agent_control.baseline` is absent and `agent_control.baseline_reduction` is `'omitted'`, exactly
 *   as it is for a baseline too large to carry.
 *
 * The default is `'structure'` when the baseline was observed and `'text'` when it was read off the
 * code, because that is where the two differ: code-side text is the author's, written knowing it is
 * editable from this Logfire project, while text snapshotted from a request is whoever's request it
 * happened to be.
 */
export type BaselinePublication = 'text' | 'structure' | 'off'

/** What a baseline gave up to fit `MAX_BASELINE_BYTES`, as `agent_control.baseline_reduction` reports it. */
export type BaselineReduction = 'none' | 'tool_definitions' | 'omitted'

/**
 * How much serialized baseline a hint span will carry, in UTF-8 bytes.
 *
 * Span attributes share a row budget in the low tens of megabytes, and the backend enforces it by
 * truncating a long string *in place* -- which for JSON means an attribute that still looks like a
 * string and no longer parses. So the budget is enforced here instead, an order of magnitude under
 * the row's, with room left for the rest of the span and for a consumer's own overhead. A baseline
 * over it is reduced by whole sections rather than cut mid-string; see `serializeBaseline`.
 */
const MAX_BASELINE_BYTES = 1 << 20

/**
 * Destinations already reported in this process, per destination.
 *
 * Keyed on the variables provider as well as the variable's name, rather than on the name alone: the
 * provider is what decides which Logfire project the config would live in, so a process reconfigured
 * onto a second project reports the agent to that one too rather than letting the first project it
 * touched stand in for both. The Python core keys the same guard on its `Logfire` instance, which is
 * the same fact where a language has more than one of them.
 */
const reported = new Map<VariableProvider, Set<string>>()

/** Everything one agent reports about itself, once per process. */
export interface ConfigHint {
  /** The `agent__<key>` variable the config belongs in. */
  variableName: string
  /** The agent's name as written in code, or absent when it has none. */
  agentName?: string
  /** Which Agent Control SDK produced the hint; see `AgentControlOptions.framework`. */
  framework: string
  /** Whether the baseline describes the agent as written or one request that happened to come first. */
  source: BaselineSource
  /** How the run's variable resolved, from `Resolution.reason`. */
  resolutionReason: string
  /** The agent as written, from `buildBaseline`. */
  baseline: AgentConfig
  /** How much of `baseline` to report; see `BaselinePublication`. */
  publication: BaselinePublication
}

/**
 * Report one agent's code baseline, at most once per process per destination.
 *
 * The span is named `agent_control_config_hint` and carries:
 *
 * - `agent_control.variable_name` -- the `agent__<key>` variable the config belongs in.
 * - `agent_control.agent_name` -- the agent's name as written in code. The variable name is derived
 *   from it lossily, so this is what says *which* agent landed on that key. Left off when there is
 *   none: absent says "there is none", where a null-valued attribute would only raise the question of
 *   whether that is a name.
 * - `agent_control.framework` -- which Agent Control SDK produced the hint. The ids a baseline
 *   addresses its instruction blocks by are each implementation's own, so a consumer has to know
 *   whose baseline it is reading.
 * - `agent_control.baseline_source` -- `'code'` or `'observed'`; see `BaselineSource`.
 * - `agent_control.schema_sha256` -- the contract schema this baseline was built against, so a
 *   consumer stores the matching JSON schema on the variable rather than guessing, and can tell a
 *   baseline from an older SDK from one it wrote the schema for.
 * - `agent_control.baseline` -- the `AgentConfig` snapshot, as the JSON a variable's `example` holds.
 *   Absent when `agent_control.baseline_reduction` is `'omitted'`.
 * - `agent_control.baseline_reduction` -- `'none'`, `'tool_definitions'`, or `'omitted'`: what the
 *   baseline had to give up to fit `MAX_BASELINE_BYTES`. Always present, so a partial baseline is
 *   partial on the record rather than by inference.
 * - `agent_control.baseline_bytes` -- the reported baseline's UTF-8 size before any reduction.
 * - `agent_control.baseline_sha256` -- the digest of the whole reported baseline, taken before any
 *   reduction, so two reports of the same code agree and two oversize reports of different code do
 *   not. A consumer verifies it against `agent_control.baseline` only when the reduction is `'none'`.
 * - `agent_control.service_name`, `agent_control.environment`, `agent_control.service_version` --
 *   which deployment reported it; see `deploymentAttributes`. Each is left off when the SDK does not
 *   know it.
 * - `agent_control.resolution_reason` -- how the run's variable resolved (`'resolved'`,
 *   `'code_default'`, ...). Since every agent reports, the span's existence no longer says whether one
 *   had a config, and this is the fact a consumer needs to tell a baseline that wants a config created
 *   from it from one that may only be refreshing a stale `example`.
 *
 * Attributes rather than one nested blob because the hint is a contract with a consumer that queries
 * it: a name it filters on and a size it can threshold have to be columns, and the baseline is the
 * only one of them that is a document.
 *
 * A span rather than a log record, deliberately: a log below the configured minimum level is dropped,
 * and a signal the platform contract depends on cannot be something a logging setting silently
 * withholds. It takes no time, so it opens and closes on the spot.
 *
 * The guard is marked *before* the work, so concurrent first requests cannot report twice and a
 * failure is not retried by every later run. Which is also what makes the caller's job easy: call it
 * on every request and let this decide.
 */
export function reportConfigHint(hint: ConfigHint): void {
  const provider = getVariableProvider()
  let names = reported.get(provider)
  if (names === undefined) {
    names = new Set<string>()
    reported.set(provider, names)
  }
  if (names.has(hint.variableName)) {
    return
  }
  names.add(hint.variableName)

  const baseline = hint.publication === 'structure' ? structureOnly(hint.baseline) : hint.baseline
  const { serialized, reduction, bytes } = serializeBaseline(baseline, hint.publication)
  const attributes: Record<string, unknown> = {
    'agent_control.variable_name': hint.variableName,
    'agent_control.framework': hint.framework,
    'agent_control.baseline_source': hint.source,
    'agent_control.schema_sha256': SCHEMA_SHA256,
    'agent_control.baseline_sha256': baselineSha256(baseline),
    'agent_control.baseline_reduction': reduction,
    'agent_control.baseline_bytes': bytes,
    'agent_control.resolution_reason': hint.resolutionReason,
    ...deploymentAttributes(),
  }
  if (hint.agentName !== undefined && hint.agentName !== '') {
    attributes['agent_control.agent_name'] = hint.agentName
  }
  if (serialized !== undefined) {
    attributes['agent_control.baseline'] = serialized
  }
  span(CONFIG_HINT_MESSAGE, {
    _spanName: CONFIG_HINT_SPAN_NAME,
    attributes,
    callback: () => undefined,
  })
}

/**
 * Serialize a baseline to fit `MAX_BASELINE_BYTES`, dropping whole sections when it does not.
 *
 * Returns the JSON to put on the hint span (`undefined` when nothing is carried), which reduction was
 * applied, and the baseline's size in UTF-8 bytes before any of it.
 *
 * Reduction drops `tool_definitions` first and then gives up, rather than trimming text to a budget.
 * The contract already bounds a single instruction block, so a baseline this large is one with an
 * unbounded *number* of things in it, and tool definitions are where that goes: every advertised
 * tool, its description, and an entry per parameter. They are also the section a config needs least
 * -- the editor can offer a tool override without one, while a baseline with no instructions has
 * nothing to show at all. Either way the result is a whole, valid `AgentConfig` and the reduction is
 * named on the span, so a consumer reads a baseline that is complete or knowingly partial, never one
 * that parses into something the agent does not do.
 *
 * `'off'` lands in the same place a baseline too large to carry does, and says so the same way: there
 * is one state on the span for "the document is not here", and a second word for it would only be a
 * second thing for a consumer to learn.
 */
function serializeBaseline(
  baseline: AgentConfig,
  publication: BaselinePublication
): { serialized: string | undefined; reduction: BaselineReduction; bytes: number } {
  const serialized = dump(baseline)
  const bytes = Buffer.byteLength(serialized)
  if (publication === 'off') {
    return { serialized: undefined, reduction: 'omitted', bytes }
  }
  if (bytes <= MAX_BASELINE_BYTES) {
    return { serialized, reduction: 'none', bytes }
  }
  const { tool_definitions: _dropped, ...rest } = baseline
  const reduced = dump(rest)
  if (Buffer.byteLength(reduced) <= MAX_BASELINE_BYTES) {
    return { serialized: reduced, reduction: 'tool_definitions', bytes }
  }
  return { serialized: undefined, reduction: 'omitted', bytes }
}

/** The baseline as the JSON a hint carries, indented the way a variable's `example` is read. */
function dump(baseline: AgentConfig): string {
  return JSON.stringify(baseline, null, 2)
}

/**
 * The digest that says whether two reports describe the same code.
 *
 * Always over the *whole* reported baseline, never over the JSON the span ended up carrying. A
 * baseline too large for a span attribute is reported with its tool definitions dropped, or with no
 * baseline at all, and a digest taken after that would change when nothing about the agent had -- and
 * would leave every oversize report looking like every other one, which is the case that has nothing
 * else to tell it apart by.
 *
 * Taken over the canonical form -- keys sorted recursively, no whitespace, non-ASCII emitted rather
 * than escaped -- which is the same form `SCHEMA_SHA256` is taken over, and the same one Python's
 * `json.dumps(..., sort_keys=True, separators=(',', ':'), ensure_ascii=False)` produces. Sorting is
 * what makes the digest independent of the order a baseline's keys were written in; `ensure_ascii`
 * is what makes it independent of the language computing it, so the first instruction block with an
 * accent in it does not give two identical baselines two different digests.
 */
function baselineSha256(baseline: AgentConfig): string {
  return createHash('sha256').update(canonicalJson(baseline), 'utf8').digest('hex')
}

/**
 * The baseline's seams with none of its text; see `BaselinePublication`.
 *
 * Every id, name, and key survives, because those are what an editor addresses an override to. Every
 * piece of prose is left behind: instruction text, tool descriptions, parameter descriptions. The
 * model and the settings stay -- a model id is a name and the canonical settings are numbers, neither
 * of which is anyone's content -- and the settings were already filtered to the canonical keys by
 * `buildBaseline`, which is what keeps extra headers and signed bodies out of a baseline in the first
 * place.
 *
 * An entry with nothing addressable left is dropped rather than reported as an empty object: an added
 * block with no id is only its text, so with the text gone there is nothing for an editor to show.
 */
function structureOnly(baseline: AgentConfig): AgentConfig {
  const stripped: AgentConfig = {}

  const instructions = baseline.instructions
  if (Array.isArray(instructions)) {
    const seams: InstructionBlockConfig[] = []
    for (const block of instructions) {
      // A bare string is an added block, which is its text and nothing else.
      if (typeof block === 'string' || block.id === undefined) {
        continue
      }
      const seam: InstructionBlockConfig = { id: block.id }
      if (block.dynamic !== undefined) {
        seam.dynamic = block.dynamic
      }
      seams.push(seam)
    }
    if (seams.length > 0) {
      stripped.instructions = seams
    }
  }

  if (baseline.model !== undefined) {
    stripped.model = baseline.model
  }
  if (baseline.settings !== undefined) {
    stripped.settings = baseline.settings
  }

  if (baseline.tool_definitions !== undefined) {
    stripped.tool_definitions = baseline.tool_definitions.map(toolSeams)
  }

  return stripped
}

/** One tool's seams: the names an override addresses, and none of the prose. */
function toolSeams(tool: ToolDefinitionOverride): ToolDefinitionOverride {
  const seam: ToolDefinitionOverride = { name: tool.name }
  if (tool.new_name !== undefined) {
    seam.new_name = tool.new_name
  }
  if (tool.parameters !== undefined) {
    seam.parameters = Object.fromEntries(Object.keys(tool.parameters).map((name) => [name, {}]))
  }
  if (tool.toolset !== undefined) {
    seam.toolset = tool.toolset
  }
  return seam
}

/**
 * Which deployment reported a baseline, from what the Logfire SDK already knows.
 *
 * The variable a config lives in is derived from the agent's name alone, so two services that each
 * define a `checkout_assistant` land on one `agent__checkout_assistant` -- and so do the same
 * service's dev and prod deployments, since a variable is one value per project and the dev/prod
 * split is its labels. Without this a consumer cannot tell whose code it is looking at. The resource
 * attributes on the span carry some of it, but a contract the platform indexes has to say what it
 * promises, and OTel resource attributes are not something this span has promised.
 *
 * Read off the SDK's own configuration rather than configured here: asking the user to restate a
 * service name they already gave `logfire.configure()` is a second place for the two to disagree.
 *
 * Anything the SDK does not know is left off rather than sent as an empty string: absent is a state a
 * consumer can act on, where `''` is a value it has to learn to disbelieve.
 */
function deploymentAttributes(): Record<string, string> {
  const identity: Record<string, string | undefined> = {
    'agent_control.service_name': logfireConfig.serviceName,
    'agent_control.environment': logfireConfig.deploymentEnvironment,
    'agent_control.service_version': logfireConfig.serviceVersion,
  }
  const attributes: Record<string, string> = {}
  for (const [name, value] of Object.entries(identity)) {
    if (value !== undefined && value !== '') {
      attributes[name] = value
    }
  }
  return attributes
}

/** Clear the once-per-process report guard. Intended for tests only. */
export function resetConfigHintGuard(): void {
  reported.clear()
}
